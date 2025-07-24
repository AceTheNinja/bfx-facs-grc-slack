# bfx-facs-grc-slack

A facility that simplifies the integration of slack message service via greanche service.

### Example configuration

```
{
  "s0": {
    "enable": true,
    "worker": "rest:ext:slack",
    "max_length": 1024,
    "channel": "slack-channel",
    "env": "development",
    "errorBatching": { // optional
      "interval": 60000,
      "maxSize": 50,
      "maxMessageLength": 4000
    }
  }
}
```
