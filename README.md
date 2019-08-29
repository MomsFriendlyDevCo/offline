Offline ServiceWorker
=====================
Provide offline syncing functionality via a service worker.

This unit works by reading package declarations from the config, syncing those when internet is available and providing its own micro-ReST server when not.

It works by using the new [Service Worker](https://developers.google.com/web/fundamentals/primers/service-workers/) browser technology which sits between the requesting browser and the server which can mediate requests.


Syncing
-------
The syncing process is made up of the following steps. `FE` is the front end, `BE` the backend and `SW` the service worker

1. [FE] Send a message to the Service Worker to sync
2. [SW] Setup a cache
3. [SW] Fetch resources from the server
4. [BE] Compute a list of resources - this is the flattened version of `app.config.offline.packages[]` specific to the active user with all dependencies resolved
5. [SW] Compose a list of all resources to check
6. [SW] Request each resource as a list, if the resource is a collection try to optimize this by fetching the collection IDs + version only then compare, if the resource is a URL just pull it


Config
------
As Service Workers are self contained JS files injecting the offline configuration is somewhat complex.

The easiest method is simply to use the supplied `gulp build` process while specifying a source file from where the config can be retrieved.

```
OFFLINE_CONFIG_FILE=./my-config.js
gulp build
```

In the above `./my-config.js` is expected to export a JavaScript object which will be stringified and used as the offline config.


Config options:

| Property                 | Type             | Description                                                                                                                                    |
|--------------------------|------------------|------------------------------------------------------------------------------------------------------------------------------------------------|
| `enabled`                | `boolean`        | Whether the service worker is enabled                                                                                                          |
| `cleanInterval`          | `number`         | Time in milliseconds between cleans                                                                                                            |
| `debug`                  | `boolean`        | Whether the service worker should output debugging messages                                                                                    |
| `debugFailures`          | `boolean`        | Whether all failures should be cached in caches/failures                                                                                       |
| `debugPrefix`            | `string`         | The prefix to use when debugging                                                                                                               |
| `fetchOptions`           | `object`         | Additional options to pass into `fetch()`                                                                                                      |
| `fetchAttempts`          | `number`         | The number of retry attempts before failing sync on network errors                                                                             |
| `fetchConcurrent`        | `number`         | Number of concurrent requests allowed by `Promise.allLimit()`                                                                                  |
| `forceOffline`           | `boolean`        | If true, treat all incoming connections as offline (inherited from `caches/meta/flags/forceOffline{enabled: true}` if its present)             |
| `autoSyncFirst`          | `number`         | Time in milliseconds until first sync (falsy to disable)                                                                                       |
| `autoSyncPollingOnline`  | `number`         | Time in milliseconds between polls after the first sync when we are online                                                                     |
| `autoSyncPollingOffline` | `number`         | Time in milliseconds between polls after the first sync when we are offline                                                                    |
| `ignore`                 | `array <string>` | List of RegExps to skip caching for (these have to be strings to survive JSON encoding)                                                        |
| `maxPostCycles`          | `number`         | Maximum number of recursive post attempts before giving up, set this to the ideal depth of A creates B creates C style loops that are possible |
| `packages`               | `array <object>` | Package specification, see below                                                                                                               |


The [base config](./src/base.config.js) file is used to set the above to appropriate defaults. The object resolved by the file at `OFFLINE_CONFIG_FILE` override those defaults.



Config Package declaration
--------------------------
The `offline.packages` object is composed as a collection with the following properties:

| Property      | Type     | Description                                                   |
|---------------|----------|---------------------------------------------------------------|
| `id`          | `string` | The unique ID to identify the package                         |
| `title`       | `string` | The human friendly string to refer to the package             |
| `description` | `string` | A longer description of the package                           |
| `payload`     | `array`  | A list of resources that should be pulled within this package |


Payload us an array of the following objects:

| Property  | Type      | Default     | Description                                                                                                                   |
|-----------|-----------|-------------|-------------------------------------------------------------------------------------------------------------------------------|
| `type`    | `string`  |             | How the resource is mediated. Enum of: `"url"`, `"collection"`                                                                |
| `url`     | `string`  |             | The URL to pull the resource from, use `{{id}}` as a specifier when iterating over a collection                               |
| `version` | `boolean` | Calculated  | Look for versioning information when pulling the resource, set to falsy to force 304 validation instead of using `__v` values. This is assumed true for `type == 'collection'` and false otherwise |
| `create`  | `boolean` | `false`     | (If `type==collection`) specifies that posting to the URL will be handled as a document creation                              |
| `count`   | `boolean` | `true`      | (If `type==collection`) specifies that the count of documents matching should be returned                                     |
| `query`   | `boolean` | `true`      | (If `type==collection`) specifies that ReST / Mongo / Sift style queries should provide a list of matching documents          |
| `post`    | `boolean` | `false`     | (If `type==collection`) specifies that posting to the URL will be handled as a document update                                |
