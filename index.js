'use strict'

const util = require('util')
const Base = require('bfx-facs-base')

class GrcSlack extends Base {
  constructor (caller, opts, ctx) {
    super(caller, opts, ctx)

    this.name = 'grc-slack'
    this._hasConf = true
    this._errorBatch = new Map()
    this.init()

    if (opts.conf) this.conf = opts.conf

    this._errorBatchingConfig = {
      interval: this.conf.errorBatching.interval || 60000,
      maxSize: this.conf.errorBatching.maxSize || 50,
      maxMessageLength: this.conf.errorBatching.maxMessageLength || 4000
    }

    this._initErrorBatching()
  }

  _initErrorBatching () {
    this._errorBatchTimer = setInterval(() => {
      this._processBatchedErrors()
    }, this._errorBatchingConfig.interval)

    this._errorBatchTimer.unref()
  }

  _stop (cb) {
    if (this._errorBatchTimer) {
      clearInterval(this._errorBatchTimer)
      this._errorBatchTimer = null
    }

    this._processBatchedErrors().catch(err => {
      console.error('Failed to process final batch of errors during shutdown', err)
    }).finally(() => {
      super._stop(cb)
    })
  }

  message (reqChannel, message) {
    if (!this.conf.enable) return Promise.resolve(false) // Add promise to keep consistency between returns
    const slack = this.conf
    const worker = slack.worker || 'rest:ext:slack'
    const maxLength = slack.max_length || 1024
    const env = (slack.env) ? `Env: ${slack.env}, ` : ''
    const rawText = env + message
    const text = (maxLength) ? rawText.substr(0, maxLength) : rawText
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

  /**
   * Batch log error to slack
   * @param {string} [reqChannel] - Slack channel to log the error to, if not provided, the channel from the config will be used
   * @param {Error} err - Error to log
   * @param {string} functionName - Name of the function where the error occurred
   * @param {Object} payload - Payload to log
   * @param {...any} extra - Additional information to log
   */
  async batchLogErrorToSlack (reqChannel, err, functionName, payload, ...extra) {
    if (!reqChannel) {
      reqChannel = this.conf.channel
    }

    try {
      const errorKey = this._createErrorKey(reqChannel, err, functionName)

      const now = new Date()
      let errorEntry = this._errorBatch.get(errorKey)

      if (!errorEntry) {
        errorEntry = {
          errorMessage: err.message,
          functionName,
          reqChannel,
          payloads: [
            payload
          ],
          count: 0,
          firstSeen: now,
          lastSeen: now
        }
        this._errorBatch.set(errorKey, errorEntry)
      }

      errorEntry.count++
      errorEntry.lastSeen = now
      errorEntry.payloads.push(payload)

      if (this._errorBatch.size >= this._errorBatchingConfig.maxSize) {
        this._processBatchedErrors()
      }
    } catch (e) {
      console.error('Error batching failed, falling back to direct log', e)
      await this.logError(reqChannel, err, functionName, payload, ...extra)
    }
  }

  _createErrorKey (reqChannel, err, functionName) {
    const errorMsg = err?.message || 'Unknown error'
    return `${reqChannel}:${functionName}:${errorMsg}`
  }

  async _processBatchedErrors () {
    if (this._errorBatch.size === 0) {
      return
    }

    try {
      const errorsByFunctionNameAndChannel = new Map()

      for (const [errorKey, errorEntry] of this._errorBatch) {
        const groupKey = `${errorEntry.reqChannel}:${errorEntry.functionName}`
        if (!errorsByFunctionNameAndChannel.has(groupKey)) {
          errorsByFunctionNameAndChannel.set(groupKey, [])
        }
        errorsByFunctionNameAndChannel.get(groupKey).push({ errorKey, ...errorEntry })
      }

      for (const [groupKey, errors] of errorsByFunctionNameAndChannel) {
        const [reqChannel, functionName] = groupKey.split(':')
        await this._sendBatchedErrorMessage(reqChannel, functionName, errors)
      }

      this._errorBatch.clear()
    } catch (e) {
      console.error('Failed to process batched errors', e)
    }
  }

  async _sendBatchedErrorMessage (reqChannel, functionName, errors) {
    const totalErrors = errors.reduce((sum, error) => sum + error.count, 0)
    const timeRange = this._getTimeRange(errors)

    let message = `*Batched Error Report - ${functionName}*\n`
    message += `*Summary:* ${totalErrors} errors across ${errors.length} types (${timeRange})\n\n`

    let truncated = false
    for (const error of errors.slice(0, 10)) {
      if (truncated) break

      message += `• *${error.errorMessage}* (${error.count}x)\n`
      message += '  Payloads:\n'

      for (const payload of error.payloads.slice(0, 3)) {
        const payloadStr = `    - ${JSON.stringify(payload)}\n`

        if (message.length + payloadStr.length > (this._errorBatchingConfig.maxMessageLength)) {
          message += `\n... message truncated (${errors.length - errors.indexOf(error)} more error types)`
          truncated = true
          break
        }

        message += payloadStr
      }

      if (error.payloads.length > 3) {
        message += `    ... and ${error.payloads.length - 3} more payloads\n`
      }
    }

    if (errors.length > 10 && !truncated) {
      message += `\n... and ${errors.length - 10} more error types`
    }

    await this.logError(reqChannel, message)
  }

  _getTimeRange (errors) {
    const allTimes = errors.flatMap(error => [error.firstSeen, error.lastSeen])
    const earliest = new Date(Math.min(...allTimes))
    const latest = new Date(Math.max(...allTimes))

    const formatTime = (date) => date.toISOString().substring(11, 19)

    if (earliest.getTime() === latest.getTime()) {
      return formatTime(earliest)
    }

    return `${formatTime(earliest)} - ${formatTime(latest)}`
  }
}

module.exports = GrcSlack
