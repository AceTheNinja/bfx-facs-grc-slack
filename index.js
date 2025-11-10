'use strict'

const util = require('util')
const Base = require('bfx-facs-base')

const { formatTime } = require('./utils/date-time')
const { createHash } = require('crypto')

class GrcSlack extends Base {
  constructor (caller, opts, ctx) {
    super(caller, opts, ctx)

    this.name = 'grc-slack'
    this._hasConf = true
    this.init()

    if (opts.conf) this.conf = opts.conf

    if (this.conf.errorBatching && opts.lru) {
      this._errorBatch = opts.lru
      this._initErrorBatching()
    }
  }

  _initErrorBatching () {
    this._errorBatchTimer = setInterval(() => {
      this._processBatchedErrors()
    }, this.conf.errorBatching?.interval || 60000)

    this._errorBatchTimer.unref()
  }

  async _stop (cb) {
    if (this._errorBatchTimer) {
      clearInterval(this._errorBatchTimer)
      this._errorBatchTimer = null
    }

    try {
      await this._processBatchedErrors()
    } catch (err) {
      console.error('Failed to process final batch of errors during shutdown', err)
    } finally {
      super._stop(cb)
    }
  }

  message (reqChannel, message) {
    if (!this.conf.enable) return Promise.resolve(false) // Add promise to keep consistency between returns
    const slack = this.conf
    const worker = slack.worker || 'rest:ext:slack'
    const maxLength = slack.max_length || 1024
    const env = (slack.env) ? `Env: ${slack.env}, ` : ''
    const rawText = env + message
    const text = (rawText.length > maxLength) ? rawText.slice(0, maxLength) : rawText
    const channel = reqChannel || slack.channel
    const send = [{ channel, text }]

    return this.caller.grc_bfx.req(
      worker,
      'postSlackMsg',
      send,
      { timeout: 10000 })
  }

  logError (reqChannel, err, ...extra) {
    const error = err instanceof Object ? util.inspect(err, { depth: 10 }) : err
    const extraP = extra.length
      ? `Extra: ${util.format(...extra.map(el => typeof el === 'object' ? util.inspect(el, { depth: 10 }) : el))}, `
      : ''
    const errTag = err instanceof Error ? '' : 'Error: '

    return this.message(reqChannel, `${extraP}${errTag}${error}`)
  }

  _createErrorGroupKey (reqChannel, sourceName) {
    return `${reqChannel}:${sourceName}`
  }

  _createErrorKey (reqChannel, err, sourceName = 'unknown') {
    const errorMsg = err?.message || err?.toString() || 'Unknown error'
    const hash = createHash('sha1').update(errorMsg).digest('hex')
    return this._createErrorGroupKey(reqChannel, sourceName) + `:${hash}`
  }

  /**
   * Batch log error to slack
   * @param {string} reqChannel - Slack channel to log the error to, if not provided, the channel from the config will be used
   * @param {Error} err - Error to log
   * @param {string} sourceName - Source of the error
   * @param {Object} payload - Payload to log
   * @param {...any} extra - Additional information to log
   */
  async logErrorEnqueue (reqChannel, err, sourceName, payload, ...extra) {
    if (!this._errorBatch) {
      console.error('Error batching not initialized, falling back to direct log')
      return this.logError(reqChannel, err, sourceName, payload, ...extra)
    }

    if (!reqChannel) {
      reqChannel = this.conf.channel
    }

    try {
      const errorKey = this._createErrorKey(reqChannel, err, sourceName)

      const now = new Date()
      let errorEntry = this._errorBatch.get(errorKey)

      if (!errorEntry) {
        errorEntry = {
          errorMessage: err.message,
          sourceName,
          reqChannel,
          payloads: [
            { payload, extras: extra }
          ],
          count: 1,
          firstSeen: now,
          lastSeen: now
        }
        this._errorBatch.set(errorKey, errorEntry)
        return
      }

      errorEntry.count++
      errorEntry.lastSeen = now
      errorEntry.payloads.push({ payload, extras: extra })

      // Keep only the last 3 payloads
      if (errorEntry.payloads.length > 3) {
        errorEntry.payloads.shift()
      }
    } catch (e) {
      console.error('Error batching failed, falling back to direct log', e)
      await this.logError(reqChannel, err, sourceName, payload, ...extra)
    }
  }

  async _processBatchedErrors () {
    if (!this._errorBatch || this._errorBatch.cache.length === 0) {
      return
    }

    try {
      const errorGroups = new Map() // group errors by function name and channel

      const allEntries = Object.values(this._errorBatch.cache.cache || {})

      for (const { value: errorEntry } of allEntries) {
        const groupKey = this._createErrorGroupKey(errorEntry.reqChannel, errorEntry.sourceName)
        if (!errorGroups.has(groupKey)) {
          errorGroups.set(groupKey, {
            errors: [],
            totalCount: 0,
            earliestTime: Infinity,
            latestTime: -Infinity
          })
        }

        const group = errorGroups.get(groupKey)
        group.errors.push(errorEntry)
        group.totalCount += errorEntry.count

        // Track time range
        const firstTime = errorEntry.firstSeen.getTime()
        const lastTime = errorEntry.lastSeen.getTime()
        if (firstTime < group.earliestTime) group.earliestTime = firstTime
        if (lastTime > group.latestTime) group.latestTime = lastTime
      }

      for (const { errors, totalCount, earliestTime, latestTime } of errorGroups.values()) {
        const { reqChannel, sourceName } = errors[0]
        await this._sendBatchedErrorMessage(reqChannel, sourceName, errors, totalCount, earliestTime, latestTime)
      }
    } catch (e) {
      console.error('Failed to process batched errors', e)
    } finally {
      this._errorBatch.clear()
    }
  }

  async _sendBatchedErrorMessage (reqChannel, sourceName, errors, totalErrors, earliestTime, latestTime) {
    const timeRange = this._formatTimeRange(earliestTime, latestTime)

    let message = `*Batched Error Report - ${sourceName}*\n`
    message += `*Summary:* ${totalErrors} errors across ${errors.length} types (${timeRange})\n\n`

    let truncated = false
    for (const error of errors.slice(0, 10)) {
      if (truncated) break

      message += `• *${error.errorMessage}* (${error.count}x)\n`
      message += '  Payloads:\n'

      for (const item of error.payloads) {
        let payloadStr = `    - ${JSON.stringify(item.payload)}\n`
        if (Array.isArray(item.extras) && item.extras.length) {
          payloadStr += `     Extras: ${JSON.stringify(item.extras)}\n`
        }

        if (message.length + payloadStr.length > (this.conf.errorBatching?.maxMessageLength || 4000)) {
          message += `\n... message truncated (${errors.length - errors.indexOf(error)} more error types)`
          truncated = true
          break
        }

        message += payloadStr
      }
    }

    if (errors.length > 10 && !truncated) {
      message += `\n... and ${errors.length - 10} more error types`
    }

    await this.logError(reqChannel, message)
  }

  _formatTimeRange (earliestTime, latestTime) {
    const earliest = new Date(earliestTime)
    const latest = new Date(latestTime)

    if (earliestTime === latestTime) {
      return formatTime(earliest)
    }

    return `${formatTime(earliest)} - ${formatTime(latest)}`
  }
}

module.exports = GrcSlack
