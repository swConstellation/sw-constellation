# SW Constellation API

A [sw-exporter](https://github.com/Xzandro/sw-exporter) plugin for Summoners War that forwards selected game traffic to the Constellation API.

It keeps a Constellation guild up to date with player profile data and guild siege activity.

## Requirements

- [sw-exporter](https://github.com/Xzandro/sw-exporter) installed and configured to capture Summoners War traffic.
- A [Constellation player account](https://www.swc.gg).
- Your member **InboundApiKey**, available from your Constellation profile.

## Installation

1. Download or clone this repository.
2. Copy the complete repository folder into sw-exporter's `plugins` directory. Keep both `package.json` and `sw-constellation-plugin.js` together in that folder.
3. Your installation should look like this:

   ```text
   sw-exporter/
   └── plugins/
       └── sw-constellation-plugin/
           ├── package.json
           └── sw-constellation-plugin.js
   ```

4. Restart sw-exporter.
5. In sw-exporter's plugin settings, enable **SW Constellation API**.
6. Paste your **InboundApiKey** into the plugin configuration.
7. Restart sw-exporter to apply the configuration.

## Configuration

| Setting | Description |
| --- | --- |
| `enabled` | Enables or disables the plugin. |
| `inboundApiKey` | Your member key from Constellation. It authenticates requests for your guild. |
| `showLogs` | Displays successful forwarding messages in sw-exporter and writes them to a log file. |

## Privacy and security

The plugin sends the required game-command payloads and profile JSON to Constellation. Your `InboundApiKey` is included only in requests to that API and is used to associate data with the correct Constellation guild and member. Treat this key as a secret: do not share it.

## Logs

When **Show logs** is enabled, the plugin displays forwarding results in sw-exporter and writes `sw-constellation-plugin.log` next to the `plugins` folder. The log file is deliberately kept outside `plugins` because sw-exporter loads every entry in that directory as a plugin.

## License

Released under the MIT License.

## Disclaimer

This is an independent community plugin. It is not affiliated with, endorsed by, or sponsored by Com2uS.
