'use strict';

const AWS = require('aws-sdk')
const lambda = new AWS.Lambda()
const s3 = new AWS.S3()
const _ = require('lodash')
const naming = require("./naming.js")
const shard = require("./shard.js")
const s3utils = require("./s3utils.js")
const customize = require("./customize.js")

// dispatch any necessary continued resharding or history processing
// this is called by firehose.js every time a new firehose file is created
// this function is not designed to be executed concurrently, so we set the reservedConcurrency to 1 in serverless.yml
//
// Options to ignore processing timers
// 
// force_processing: true
// force_continue_reshard: true
module.exports.dispatchRewardAssignmentWorkers = async (event, context) => {
  console.log(`processing lambda event ${JSON.stringify(event)}`)

  const projectNames = naming.allProjects()
  return Promise.all(projectNames.map(projectName => {
    // get all of the shard ids & load the shard timestamps
    return Promise.all([naming.listAllShards(projectName), shard.loadAndConsolidateShardLastProcessedDates(projectName)]).then(([shards, shardLastProcessedDates]) => {
      if (!shards.length) {
        console.log(`skipping project ${projectName} - no shards found`)
        return
      }
      const sortedShards = shards.sort() // sort() modifies shards
      // group the shards
      const [reshardingParents, reshardingChildren, nonResharding] = shard.groupShards(sortedShards)
      console.log(`project ${projectName} has ${shards.length-nonResharding.length}/${shards.length} shards currently resharding`)
      // check to see if any of the resharding parents didn't finish and sharding needs to be restarted
      // & check to see if any non-resharding shards have incoming history meta files and haven't been processed recently according to the timestamps
      return Promise.all([shard.dispatchReshardingIfNecessary(context, projectName, reshardingParents, shardLastProcessedDates, event.force_continue_reshard), 
                          dispatchAssignRewardsIfNecessary(context, projectName, nonResharding, shardLastProcessedDates, event.force_processing)])
    })
  }))
}

function dispatchAssignRewardsIfNecessary(lambdaContext, projectName, nonReshardingShards, lastProcessedDates, forceProcessing = false) {
  const nonReshardingShardsSet = new Set(nonReshardingShards)
  const now = new Date()
  const epoch = new Date(0)
  
  // list all incoming history shards
  return naming.listAllIncomingHistoryShards(projectName).then(incomingShards => {
    
    const incomingShardsWithDates = incomingShards.map(v => [v, (lastProcessedDates[v] || epoch)])
    
    // process the oldest ones first
    incomingShardsWithDates.sort((a, b) => a[1] - b[1])
    
    let remainingWorkers = Math.max(process.env.REWARD_ASSIGNMENT_WORKER_COUNT, 1)
    console.log(`processing up to ${remainingWorkers} shard(s) for project ${projectName}`)
    
    return Promise.all(incomingShardsWithDates.map(([shardId, lastProcessed]) => {

      if (!forceProcessing && remainingWorkers <= 0) {
        return
      }

      // check if the incoming shard isn't currently being resharded and if it hasn't been processed too recently
      if (!forceProcessing && !nonReshardingShardsSet.has(shardId)) {
        console.log(`skipping project ${projectName} shard ${shardId} for history processing, currently resharding`)
        return 
      }
      
      if (!forceProcessing && (now - lastProcessed) < process.env.REWARD_ASSIGNMENT_REPROCESS_SHARD_WAIT_TIME_IN_SECONDS * 1000) {
        console.log(`skipping project ${projectName} shard ${shardId} for history processing, last processing ${lastProcessed.toISOString()} was too recent`)
        return
      }
      
      remainingWorkers--

      console.log(`invoking assignRewards for project ${projectName} shard ${shardId} last processed at ${lastProcessed.toISOString()}`)
  
      const params = {
        FunctionName: naming.getLambdaFunctionArn("assignRewards", lambdaContext.invokedFunctionArn),
        InvocationType: "Event",
        Payload: JSON.stringify({"project_name": projectName, "shard_id": shardId, "last_processed_timestamp_updated": true }) // mark that the last processed time is updated so that assignRewards doesn't have to also do it
      };
      
      // mark the last processed time as being updated here to have the smallest possible window where multiple redundant workers could be accidentally dispatched
      return Promise.all([shard.updateShardLastProcessed(projectName, shardId), lambda.invoke(params).promise()])
    }))
  })
}

module.exports.assignRewards = async function(event, context) {
  
  console.log(`processing event ${JSON.stringify(event)}`)

  const projectName = event.project_name
  const shardId = event.shard_id

  if (!projectName || !shardId) {
    throw new Error(`WARN: missing project_name or shard_id ${JSON.stringify(event)}`)
  }
  
  let updateLastProcessed = Promise.resolve(true)
  // this lambda should only ever be invoked from dispatchHistoryProcessingIfNecessary, but in case
  // some design changes in the future we want to make sure to mark the last processed time is guaranteed to be updated
  if (!event.last_processed_timestamp_updated) {
    updateLastProcessed = shard.updateShardLastProcessed(projectName, shardId)
  }

  // list the incoming keys and history keys for this shard
  return updateLastProcessed.then(() => Promise.all([naming.listAllHistoryShardS3KeysMetadata(projectName, shardId), naming.listAllIncomingHistoryShardS3Keys(projectName, shardId)]).then(([historyS3KeysMetadata, incomingHistoryS3Keys]) => {
    const staleS3KeysMetadata = filterStaleHistoryS3KeysMetadata(historyS3KeysMetadata, incomingHistoryS3Keys)

    // check size of the keys to be re-processed and reshard if necessary
    const totalSize = staleS3KeysMetadata.reduce((acc, cur) => acc+cur.Size,0)
    console.log(`${totalSize} bytes of stale history data for project ${projectName} shard ${shardId}`)
    if (totalSize > (process.env.REWARD_ASSIGNMENT_WORKER_MAX_PAYLOAD_IN_MB * 1024 * 1024)) {
      console.log(`resharding project ${projectName} shard ${shardId} - stale history data is too large`)
      return shard.invokeReshardLambda(context, projectName, shardId)
    }
    
    return loadAndConsolidateHistoryRecords(staleS3KeysMetadata.map(o => o.Key)).then(staleHistoryRecords => {

      // perform customize before we access the records
      staleHistoryRecords = customize.modifyHistoryRecords(projectName, staleHistoryRecords)

      // group history records by history id
      const historyRecordsByHistoryId = Object.fromEntries(Object.entries(_.groupBy(staleHistoryRecords, 'history_id')))

      // convert history records into rewarded decisions
      let rewardedDecisions = []
      
      for (const [historyId, historyRecords] of Object.entries(historyRecordsByHistoryId)) {
        rewardedDecisions = rewardedDecisions.concat(getRewardedDecisionsForHistoryRecords(projectName, historyId, historyRecords))
      }

      return writeRewardedDecisions(projectName, shardId, rewardedDecisions)      
    }).then(() => {
      // incoming has been processed, delete them.
      return s3utils.deleteAllKeys(incomingHistoryS3Keys)
    })
  }))
}

// TODO filter
function filterStaleHistoryS3KeysMetadata(historyS3Keys, incomingHistoryS3Keys) {
  // TODO log the dates that we're looking at
  // Oh crap, we can't process decisions after date X if we're processing in the middle of a window. So if we receive some old events
  // we need to grab the entire window for those old events and ONLY process those old events.
  return historyS3Keys
}

function loadAndConsolidateHistoryRecords(historyS3Keys) {
  const messageIds = new Set()
  let duplicates = 0
  let rewardsRecordCount = 0

  // group the keys by path
  return Promise.all(Object.entries(naming.groupHistoryS3KeysByDatePath(historyS3Keys)).map(([path, pathS3Keys]) => {
      // load all records from the s3 keys for this specific path
      return Promise.all(pathS3Keys.map(s3Key => s3utils.processCompressedJsonLines(process.env.RECORDS_BUCKET, s3Key, (record) => {
        // check for duplicate message ids.  This is most likely do to re-processing firehose files multiple times.
        const messageId = record.message_id
        if (!messageId || messageIds.has(messageId)) {
          duplicates++
          return null
        } else {
          messageIds.add(messageId)
          if (record.rewards) {
            rewardsRecordCount++
          }
          return record
        }
      }))).then(all => all.flat()).then(records => {
        if (pathS3Keys.length == 1) {
          return records
        }

        console.log(`consolidating ${pathS3Keys.length} files at ${path} into 1 file`)
        const buffers = records.map(record => Buffer.from(JSON.stringify(record)+"\n"))
        return s3utils.compressAndWriteBuffers(naming.getConsolidatedHistoryS3Key(pathS3Keys[0]), buffers).then(() => {
          s3utils.deleteAllKeys(pathS3Keys)
        }).then(() => records)
      })
  })).then(all => {
    const records = all.flat()
    if (duplicates) {
      console.log(`ignoring ${duplicates} records with missing or duplicate message_id fields`)
    }
    console.log(`loaded ${records.length} records, ${rewardsRecordCount} with rewards`)

    return records
  })
}

// throw an Error on any parsing problems or customize bugs, causing the whole historyId to be skipped
// TODO parsing problems should be massaged before this point so that the only possible source of parsing bugs
// is customize calls.
function getRewardedDecisionsForHistoryRecords(projectName, historyId, historyRecords) {
  // TODO write traverse/dump function for summarizing keys 

  const decisionRecords = []
  const rewardsRecords = []
  for (const historyRecord of historyRecords) {
    // make sure the history ids weren't modified in customize
    if (historyId !== historyRecord.history_id) {
      // (this might not be a big deal since we're using shard Id to write)
      throw new Error(`historyId ${historyId} does not match record ${JSON.stringify(historyRecord)}`)
    }
    
    // grab all the values that we don't want to change before during further calls to customize
    const timestamp = historyRecord.timestamp
    const timestampDate = new Date(timestamp)
    if (!timestamp || isNaN(timestampDate.getTime())) {
      throw new Error(`invalid timestamp for history record ${JSON.stringify(historyRecord)}`)
    }
    const messageId = historyRecord.message_id
    if (!messageId || !_.isString(messageId)) {
      throw new Error(`invalid message_id for history record ${JSON.stringify(historyRecord)}`)
    }

    let inferredDecisionRecords; // may remain null or be an array of decisionRecords
    
    // the history record may be of type "decision", in which case it itself is an decision record
    if (historyRecord.type === "decision") {
      inferredDecisionRecords = [historyRecord]
    }
    
    // the history record may have attached "decisions"
    if (historyRecord.decisions) {
      if (!Array.isArray(historyRecord.decisions)) {
        throw new Error(`attached decisions must be array type ${JSON.stringify(historyRecord)}`)
      } 
      
      if (!inferredDecisionRecords) {
        inferredDecisionRecords = historyRecord.decisions
      } else {
        inferredDecisionRecords.concat(historyRecord.decisions)
      }
    }

    // may return a single decision record, an array of decision records, or null
    let newDecisionRecords = customize.decisionRecordsFromHistoryRecord(projectName, historyRecord, inferredDecisionRecords)

    if (newDecisionRecords) {
      // wrap it as an array if they just returned one decision record
      if (!Array.isArray(newDecisionRecords)) {
        newDecisionRecords = [newDecisionRecords]
      }
      for (let i=0;i<newDecisionRecords.length;i++) {
        const newDecisionRecord = newDecisionRecords[i]
        newDecisionRecord.type = "decision" // allows getRewardedDecisions to assign rewards in one pass
        newDecisionRecord.timestamp = timestamp
        newDecisionRecord.timestampDate = timestampDate // for sorting. filtered out later
        // give each decision a unique message id
        newDecisionRecord.message_id = i == 0 ? messageId : `${messageId}-${i}`;
        newDecisionRecord.history_id = historyId

        decisionRecords.push(newDecisionRecord)
      }
    }
    
    // may return a single rewards record or null
    let newRewardsRecord = customize.rewardsRecordFromHistoryRecord(projectName, historyRecord)

    if (newRewardsRecord) {
      if (!naming.isObjectNotArray(newRewardsRecord.rewards)) {
        throw new Error(`rewards must be object type and not array ${JSON.stringify(newRewardsRecord)}`)
      } 
      
      newRewardsRecord.type = "rewards" // allows getRewardedDecisions to assign rewards in one pass
      // timestampDate is used for sorting
      newRewardsRecord.timestampDate = timestampDate
      rewardsRecords.push(newRewardsRecord)
    }
  }

  return assignRewardsToDecisions(decisionRecords, rewardsRecords)
}

// in a single pass assign rewards to all decision records
function assignRewardsToDecisions(decisionRecords, rewardsRecords) {
  if (!rewardsRecords.length) {
    // for sparse rewards this should speed up processing considerably
    return decisionRecords
  }
  
  // combine all the records together so we can process in a single pass
  const sortedRecords = decisionRecords.concat(rewardsRecords).sort((a, b) => a.timestampDate - b.timestampDate)
  const decisionRecordsByRewardKey = {}
  
  for (const record of sortedRecords) {
    // set up this decision to listen for rewards
    if (record.type === "decision") {
      let rewardKey = "reward" // default reward key
      if (record.reward_key) {
        rewardKey = record.reward_key
      }
      let listeners = decisionRecordsByRewardKey[rewardKey]
      if (!listeners) {
        listeners = []
        decisionRecordsByRewardKey[rewardKey] = listeners
      }
      // TODO robust configuration
      record.rewardWindowEndDate = new Date(record.timestampDate.getTime() + customize.config.rewardWindowInSeconds * 1000)
      listeners.push(record)
    } else if (record.type === "rewards") {
      // iterate through each reward key and find listening decisions
      for (const [rewardKey, reward] of Object.entries(record.rewards)) {
        const listeners = decisionRecordsByRewardKey[rewardKey]
        if (!listeners) {
          continue;
        }
        // loop backwards so that removing an expired listener doesn't break the array loop
        for (let i = listeners.length - 1; i >= 0; i--) {
          const listener = listeners[i]
          if (listener.rewardWindowEndDate < record.timestampDate) { // the listener is expired
            listeners.splice(i,1) // remove the element
          } else {
            listener.reward = (listener.reward || 0) + Number(reward) // Number allows booleans to be treated as 1 and 0
          }
        }
      }
    } else { 
      throw new Error(`type must be \"decision\" or \"rewards\" ${JSON.stringify(record)}`)
    }
  }
  
  return decisionRecords
}

function writeRewardedDecisions(projectName, shardId, rewardedDecisions) {
  const buffersByS3Key = {}
  let rewardedRecordCount = 0
  let totalRewards = 0
  let maxReward = 0

  for (let rewardedDecision of rewardedDecisions) {
    const timestampDate = rewardedDecision.timestampDate
    rewardedDecision = finalizeRewardedDecision(projectName, rewardedDecision)

    const reward = rewardedDecision.reward
    if (reward) {
      rewardedRecordCount++
      totalRewards += reward
      maxReward = Math.max(reward, maxReward)
    }

    const s3Key = naming.getRewardedDecisionS3Key(projectName, getModelForDomain(projectName, rewardedDecision.domain), shardId, timestampDate)
    let buffers = buffersByS3Key[s3Key]
    if (!buffers) {
      buffers = []
      buffersByS3Key[s3Key] = buffers
    }
    buffers.push(Buffer.from(JSON.stringify(rewardedDecision)+"\n"))
  }

  console.log(`writing ${rewardedDecisions.length} rewarded decision records for project ${projectName} shard ${shardId}`)
  if (rewardedDecisions.length) {
    console.log(`(max reward ${maxReward}, mean reward ${totalRewards/rewardedDecisions.length}, non-zero rewards ${rewardedRecordCount})`)
  }

  return Promise.all(Object.entries(buffersByS3Key).map(([s3Key, buffers]) => s3utils.compressAndWriteBuffers(s3Key, buffers)))
}

function finalizeRewardedDecision(projectName, rewardedDecisionRecord) {
  let rewardedDecision = _.pick(rewardedDecisionRecord, ["chosen", "context", "domain", "timestamp", "message_id", "history_id", "reward", "propensity"])

  // an exception here will cause the entire history process task to fail
  rewardedDecision = customize.modifyRewardedDecision(projectName, rewardedDecision)
  naming.assertValidRewardedDecision(rewardedDecision)
  
  return rewardedDecision
}

// cached wrapper of naming.getModelForDecision
const projectDomainModelCache = {}
function getModelForDomain(projectName, domain) {
  // this is looked up for every rewarded domain record during history procesing so needs to be fast
  let domainModelCache = projectDomainModelCache[projectName]
  if (domainModelCache) {
    const model = domainModelCache[domain]
    if (model) {
      return model
    }
  }
  
  const model = naming.getModelForDomain(projectName, domain)
  domainModelCache = {[domain]: model}
  projectDomainModelCache[projectName] = domainModelCache
  return model
}

module.exports.markHistoryS3KeyAsIncoming = (historyS3Key) => {
  if (!naming.isHistoryS3Key(historyS3Key)) {
    throw new Error(`${historyS3Key} must be a history key`)
  }

  const incomingHistoryS3Key = naming.getIncomingHistoryS3Key(historyS3Key)
  console.log(`marking ${incomingHistoryS3Key}`)
  const params = {
    Body: JSON.stringify({ "s3_key": historyS3Key }),
    Bucket: process.env.RECORDS_BUCKET,
    Key: incomingHistoryS3Key
  }

  return s3.putObject(params).promise()
}
