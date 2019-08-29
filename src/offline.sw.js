/**
* Offline ReST caching service
* This ServiceWorker creates several caches and stores the contents of offline resources within them
*
* Cache:
*        'resource' - The conents of a raw HTTP response (these are either mass-fetched collection records or single url fetches)
*        'meta' - Generic meta information stored as JSON objects
*        'indexes' - Indexes stored against the `item` portion of the collection spec
*        'posts' - Requests to the server which are stored during the last offline session
*        'failures' (Only if config.debugFailures) - Failed requests while in offline mode
*/

import sift from "sift";


// Config {{{
var config = {/*@ OFFLINE_CONFIG @*/};

// Various config neatening
config.ignore = config.ignore.map(c => new RegExp(c)); // Convert ignore rules into RegExps
// }}}


// Utility functions {{{
// Most of these are taken from @momsfriendlydevco/nodash
// See that project for documentation but they more or less ape the Lodash equivelent function names

/* @if settings.debug */
/**
* Simple function to echo to console.log with a prefix
* @param {*} [parts...] Message parts to concatinate similar to console.log
*/
var debug = (...msg) => console.log.apply(this, [config.debugPrefix].concat(msg || []));
/* @endif */
/* @if !settings.debug */
var debug = ()=> {}; // Noop
/* @endif */

var escapeRegExp = str => str.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');

var castArray = input =>
	typeof input == 'object' && Object.prototype.toString.call(input) == '[object Array]'
	? input
	: new Array(input);

var flatten = arr => [].concat.apply([], arr); // Flatten by one level

var omit = (input, keys) => {
	var ids = keys instanceof Set ? keys : new Set(Array.isArray(keys) ? keys : [keys]);
	return Object.keys(input).reduce((t, k) => {
		if (!ids.has(k)) t[k] = input[k];
		return t;
	}, {});
};


/**
* Return a simple response object without all the needless wrapping
* @param {Object|string} body The body content to encode
* @param {string} [type='application/json'] The response type to return
* @returns {Response} A valid response object
*/
var wrapResponse = (body, type = 'application/json') => new Response(
	new Blob([
		typeof body != 'string' ? JSON.stringify(body) : body // Encode body as JSON if we're not given a string
	], {type})
);

/**
* Resolve a series of promises in series
* This works the same as Promise.all() but resolves its payload, one at a time until all promises are resolved
* NOTE: Because of the immediately-executing 'feature' of Promises it is recommended that the input array provide
*       an array of functions which return Promises rather than promises directly - i.e. return promise factories
*
* @example Evaluate a series of promises with a delay, one at a time, in order (note that the map returns a promise factory, otherwise the promise would execute immediately)
* Promise.allSeries(
*   [500, 400, 300, 200, 100, 0, 100, 200, 300, 400, 500].map((delay, index) => ()=> new Promise(resolve => {
*     setTimeout(()=> { console.log('EVAL', index, delay); resolve(); }, delay);
*   }))
* )
*/
Promise.allSeries = promises =>
	promises.reduce((chain, promise) =>
		chain.then(()=>
			Promise.resolve(
				typeof promise == 'function' ? promise() : promise
			)
		)
	, Promise.resolve()
);

/**
* Resolve promises similar to Promise.all() but only allow a set number of promises to be running at once
* This works the same as Promise.all() but resolves its payload until all promises are resolved
* NOTE: Because of the immediately-executing 'feature' of Promises it is recommended that the input array provide
*       an array of functions which return Promises rather than promises directly - i.e. return promise factories
*
* @example Evaluate a series of promises with a delay, one at a time, in order (note that the map returns a promise factory, otherwise the promise would execute immediately)
* Promise.allLimit(
*   3, // Allow only 3 promises to run at once
*   [500, 400, 300, 200, 100, 0, 100, 200, 300, 400, 500].map((delay, index) => ()=> new Promise(resolve => {
*     setTimeout(()=> { console.log('EVAL', index, delay); resolve(); }, delay);
*   }))
* )
* @url https://github.com/MomsFriendlyDevCo/Nodash
*/
Promise.allLimit = (limit, promises) => new Promise((resolve, reject) => {
	if (!limit) {
		debug('No limit specified for allLimit, using default of 10.');
		limit = 10;
	}

	var promiseChecker = function(queue) {
		if (!queue.promisesRemaining.length && queue.running == 0) return resolve(queue.output);

		while (queue.promisesRemaining.length > 0 && queue.running < queue.limit) {
			var promiseRunner = function(thisPromise, promiseIndex) {
				queue.running++;
				Promise.resolve(thisPromise())
					.then(res => {
						queue.output[promiseIndex] = res;
						queue.completed++;
						queue.running--;
						// Potential to do some progress notification here:
						// notify({completed: queue.completed, count: queue.promiseCount, limit: queue.limit});
						promiseChecker(queue);
					})
					.catch(reject);
			}(queue.promisesRemaining.shift(), queue.promiseIndex++);
		}
	};

	promiseChecker({
		limit,
		running: 0,
		promiseCount: promises.length,
		completed: 0,
		promisesRemaining: promises,
		output: [],
		promiseIndex: 0,
	});
});

/**
* Fetch a URL and reuse the same promise if we are already doing so
* @param {Object} cache Object storage to cache fetch promises, this should drop out of scope (and be garbage collected) when all promises have resolved
* @param {string} url The URL to fetch (standard fetch options are automatically applied)
* @param {Object} options Additional options to pass
* @param {boolean} [options.json=false] Evaluate the body element as JSON and return the response
* @param {function|array} [options.once] Additional function(s) to add as a .then when the function resolves these are evaluated in order
* @returns {Promise} A (possibly shared) promise for the eventual fetch response
*
* @example Request a URL once, decode it as JSON and one a function on it once
* var cache = {};
* fetchThrottled(cache, '/api/widgets', {json: true, once: res => { ... some mutator function ... }})
*/
var fetchThrottled = (cache, url, options) => {
	if (cache[url]) return cache[url]; // Already running this chain, return the promise

	var chain = fetch(url, config.fetchOptions);

	if (options && options.json) chain = chain.then(res => res.json());
	if (options && options.once) castArray(options.once).forEach(o => chain = chain.then(o));

	return cache[url] = chain;
};

/**
* Fetch a URL and keep retrying
* @param {string} url The URL to fetch (standard fetch options are automatically applied)
* @param {Object} options Additional options to pass
* @returns {Promise} A promise for the eventual fetch response
*
* @example Request a URL once, decode it as JSON and one a function on it once
* var cache = {};
* fetchRetry('/api/widgets', {})
*/
var fetchRetry = (url, options = {}) => {
	Object.assign(options, config.fetchOptions);
	return new Promise((resolve, reject) => {
		var attempts = 0;
		var fetchAttempt = () => {
			return fetch(url, options)
				.then(resolve)
				.catch(e => {
					console.error(e.message, attempts, config.fetchAttempts, url);
					if (config.fetchAttempts && attempts > config.fetchAttempts) return reject(new Error('Exhausted fetch attempts'));
					setTimeout(fetchAttempt, 100);
					attempts++;
				});
		};
		fetchAttempt();
	});
};

/**
* Return only the absolute pathname component of a given URL stripped of queries and hashbang
* @param {string} url The input URL
* @returns {string} The modified URL
*/
var urlPath = url => {
	if (/^\//.test(url)) url = location.origin + url; // URL is absolute to this location
	var url = new URL(url);
	return url.origin + url.pathname;
};


/**
* Generate a (Hopefully) unique ID for new documents during a create event
* Curent format is composed of date (ms) + random number(1000-9999), both as hex
* @returns {string} A unique string which can be used as the documents ID
*/
var mkId = ()=>
	'NEW-' + Date.now().toString(16) + '-' + (1000 + Math.ceil(Math.random()*8999)).toString(16);


/**
* Returns true if an ID looks like it was created with mkId - and is therefore fake
* @param {string} input The input string to examine
* @returns {boolean} True if the string resembles something created with `mkId()`
*/
var isMkId = input =>
	/^NEW-[a-f0-9]+-[a-f0-9]+$/.test(input);
// }}}

// Event: Install - cache all base resources {{{
self.addEventListener('install', ()=> {
	debug('Install!');
	self.skipWaiting();
});
// }}}

// Event: Activate {{{
self.addEventListener('activate', function(event) {
	debug('Activate!');

	event.waitUntil(
		self.clients.claim() // FIXME: Really not even sure what this is for - MC 2018-08-26
		// FIXME: Some discussion of `claim` not waiting before resolving promise here: https://github.com/w3c/ServiceWorker/issues/799 BK 2019-06-14
	)

	self.keyVal.get('meta', 'flags/forceOffline', {enabled: false})
		.then(fo => {
			if (fo.enabled) {
				debug('--- FORCING OFFLINE MODE ---');
				debug('Delete `Application > Cache Storage > meta > "forceOffline"` to reset this');
				config.forceOffline = true;
			}
		})

	self.installAutoSync();
});
// }}}

// Event: Fetch - return a response if we are live or a cached response if not {{{
self.serve = { // Methods of serving a request

	/**
	* Try serving from the network if we have a connection (and we're not forcing offline mode, unless its in config.ignore)
	* Otherwise fall back to cache
	* @param {Request} req The request object
	* @returns {Promise <Reponse>} A promise which will either respond with the live response, cached response or throw
	*/
	fromAny: req => {
		var path = new URL(req.url).pathname;
		const clone = req.clone();

		return config.forceOffline && !config.ignore.every(matchUrl => matchUrl.test(path))
			? self.serve.fromCache(req)
			: self.serve.fromNetwork(req)
				.catch(e => self.serve.fromCache(clone));
	},


	/**
	* Serve a resource exclusively from the local cache
	* NOTE: Because of the weird way promises work we have to reject out of the promise chain when we are successful
	* @param {Request} req The request object
	* @returns {Promise <Reponse>} A promise which will either respond with the cache resource or throw
	*/
	fromCache: req => {
		var resourceCache; // Resource cache handle if and when we retrieve it
		var resources;

		//debug('fromCache', req.method, req.url);

		return Promise.resolve()
			// Prep - Ensure we have a cached version of the resources map {{{
			.then(()=> self.resolveResources())
			.then(res => resources = res)
			// }}}
			// Step 1 - Is the request a create / PUT / POST (wo/ID)? {{{
			.then(()=> {
				if (req.method != 'PUT' && req.method != 'POST') return; // Not a put request - pass thru
				var collectionHandler = resources.find(r =>
					r.type == 'collection' && r.matcher.collectionCreate && r.matcher.collectionCreate.test(req.url)
				); // A collection is handling this creation?
				//console.log('PUT', 'collectionHandler', collectionHandler, req.url);
				if (!collectionHandler) return; // Flow though to next endpoint

				return req
					.text() // Extract the blob of data being saved
					.then(body => {
						if (body) body = JSON.parse(body); // Some creation POST come with no body
						return ({ // Compute the creation payload to save / return
							_id: mkId(), // Append fake _id to body
							...(collectionHandler.createSkeleton || {}), // Do we have a createSkeleton key?
							...body, // Anything else the user tried to POST
						});
					})
					.then(body => Promise.all([
						self.keyVal.set('posts', `${req.url}/${body._id}`, body), // Save to outgoing post cache
						self.keyVal.set('resources', `${req.url}/${body._id}`, body), // Overwrite resources cache so the next page hit is up to date (also merge the original array so we retain any meta server fields - '_id' for example)
					]).then(()=> body))
					.then(body => {
						debug(`PUT into ${req.url}/${body._id}`, body);
						return Promise.reject({ // Create a fake response to pretend we sent this, exit the promise chain
							isValid: true,
							response: wrapResponse(body),
						});
					})
			})
			// }}}
			// Step 2 - Is the request an update / POST? {{{
			.then(()=> {
				if (req.method != 'POST') return; // Not a post request - pass thru
				var collectionHandler = resources.find(r => r.type == 'collection' && r.matcher.collectionPost && r.matcher.collectionPost.test(req.url)); // A collection is handling this update?
				//console.log('POST', 'collectionHandler', collectionHandler, req.url);
				if (!collectionHandler) return; // Flow though to next endpoint

				return req
					.json() // Extract the blob of data being saved
					.then(body => Promise.all([
						self.keyVal.set('posts', req.url, body), // Save to outgoing post cache
						self.keyVal.get('resources', req.url, {})
							.then(original => self.keyVal.set('resources', req.url, {...original, ...body})), // Overwrite resources cache so the next page hit is up to date (also merge the original array so we retain any meta server fields - '_id' for example)
					]).then(()=> body))
					.then(body => {
						debug(`POST to ${req.url}`, body);
						return Promise.reject({ // Create a fake response to pretend we sent this, exit the promise chain
							isValid: true,
							response: wrapResponse(body),
						});
					})
			})
			// }}}

			// Step Y - Search query? {{{
			.then(()=> {
				var collectionHandler = resources.find(r => r.type == 'searchable' && r.matcher.searchableSearch && r.matcher.searchableSearch.test(req.url));
				if (!collectionHandler) return; // Flow though to next endpoint

				return self.keyVal.get('resources', urlPath(req.url), {}).then(body => {
					var params = (new URL(req.url)).search.replace(/^\?/, '');
					var query = jqDeserialize(params);

					// TODO: Encapsulate duplication
					// Extract meta fields {{{
					var metaFields = {
						skip: 0
					};
					['limit', 'populate', 'select', 'skip', 'sort'].forEach(f => {
						if (typeof query[f] !== 'undefined') {
							metaFields[f] = query[f];
							delete query[f];
						}
					});
					// }}}
					// Remap {id: ARRAY} into {id: {$in: ARRAY}} (Monoxide shorthand syntax) {{{
					Object.keys(query).forEach(k => {
						if (Array.isArray(query[k]))
							query[k] = {$in: query[k]};
					});
					// }}}

					body.total = 0;
					if (body.rows) {
						body.rows = self.modules.sift(query, body.rows);
						body.total = body.rows.length;
					}

					// Perform meta operations {{{
					if (body.rows && metaFields.skip || metaFields.limit) body.rows = body.rows.slice(metaFields.skip || 0, metaFields.limit ? (metaFields.skip || 0) + metaFields.limit : undefined);
					// }}}

					debug(`> Serving search results for ${req.url}`, query, '=', body.total, 'results')
					return Promise.reject({ // Create a fake response to pretend we sent this, exit the promise chain
						isValid: true,
						response: wrapResponse(body),
					});
				});
			})
			// }}}

			// Step 3 - Is the request a direct match against a cache entity? {{{
			.then(()=> caches.open('resources').then(res => resourceCache = res))
			.then(cache => resourceCache.match(urlPath(req.url))) // Shave of all hashbang information for requests
			.then(match => {
				if (match) {
					debug('> Serving cache entry for', req.url, match);
					return Promise.reject({source: 'resourceCache', isValid: true, response: match}); // Stop running this promise chain
				}
			})
			// }}}
			// Step 4 - Query a collection (count mode)? {{{
			.then(()=> {
				var collectionHandler = resources.find(r => r.type == 'collection' && r.matcher.collectionCount && r.matcher.collectionCount.test(req.url));
				if (!collectionHandler) return; // Flow though to next endpoint
				return self.keyVal.list(resourceCache, i => collectionHandler.matcher.item.test(i.url)) // Find all relevent child entries
					.then(urls => Promise.all(urls.map(url => self.keyVal.get(resourceCache, url))))
					.then(items => { // If we got to here the collection resolved and we can return the results
						var params = (new URL(req.url)).search.replace(/^\?/, '');
						var query = jqDeserialize(params);
						var results = self.modules.sift(query);
						debug(`> Serving collection count for ${req.url}`, query, '=', results.length, 'results')
						return Promise.reject({ // Pipe though Sift and stop running this promise chain
							isValid: true,
							response: wrapResponse({count: results.length}),
						});
					})
			})
			// }}}
			// Step 5 - Query a collection? {{{
			.then(()=> {
				var collectionHandler = resources.find(r => r.type == 'collection' && r.matcher.collectionQuery && r.matcher.collectionQuery.test(req.url));
				if (!collectionHandler) return; // Flow though to next endpoint

				return self.keyVal.list(resourceCache, i => collectionHandler.matcher.item.test(i.url)) // Find all relevent child entries
					.then(urls => Promise.all(urls.map(url => self.keyVal.get(resourceCache, url))))
					.then(items => { // If we got to here the collection resolved and we can return the results
						var params = (new URL(req.url)).search.replace(/^\?/, '');
						var query = jqDeserialize(params);

						// TODO: Encapsulate duplication
						// Extract meta fields {{{
						var metaFields = {};
						['limit', 'populate', 'select', 'skip', 'sort'].forEach(f => {
							if (query[f]) {
								metaFields[f] = query[f];
								delete query[f];
							}
						});
						if (metaFields.populate) debug('WARNING "populate" meta field is not supported by the offline server', {url: req.url, query, metaFields});
						// }}}
						// Remap {id: ARRAY} into {id: {$in: ARRAY}} (Monoxide shorthand syntax) {{{
						Object.keys(query).forEach(k => {
							if (Array.isArray(query[k]))
								query[k] = {$in: query[k]};
						});
						// }}}

						var results = sift(query, items);
						// Perform meta operations {{{
						if (metaFields.sort) {
							if (/,/.test(metaFields.sort)) debug('WARNING multiple sort fields are not supported by the offline server', {url: req.url, query, metaFields});
							var sortAscending = ! /^-/.test(metaFields.sort);
							var sortField = metaFields.sort.replace(/^[\-+]/, '');
							results = results.sort((a, b) =>
								a[sortField] == b[sortField] ? 0
								: a[sortField] > b[sortField] ? sortAscending ? -1 : 1
								: sortAscending ? -1 : 1
							);
						}

						if (metaFields.skip || metaFields.limit) results = results.slice(metaFields.skip || 0, metaFields.limit ? (metaFields.skip || 0) + metaFields.limit : undefined);
						// NOTE: There is no point in processing metaFields.select as it would just burn CPU to reduce the object size down
						// }}}

						debug(`> Serving collection query for ${req.url}`, query, '=', results.length, 'results');
						return Promise.reject({ // Pipe though Sift and stop running this promise chain
							isValid: true,
							response: wrapResponse(results),
						});
					})
			})
			// }}}

			// Step X - Give up {{{
			.then(()=> config.debugFailures && self.keyVal.set('failures', req.url, req)) // Cache in caches/failures before we reject
			.then(()=> Promise.reject({
				source: 'failure',
				isValid: true,
				response: new Response(new Blob([`Not available offline: ${req.url}`], {type: 'text/plain'}), {status: 404}),
			}))
			// }}}
			// End {{{
			// Because we need to exit out of the promise chain at any time the catch actually proxies to the sucess if `isValid` is present
			.catch(e => e && e.isValid
				? Promise.resolve(e.response)
				: Promise.reject(e)
			);
			// }}}
	},


	/**
	* Serve a resource exclusively from the live network
	* NOTE: If the resource url matches an existing resource in the resources cache that cache item is also updated
	* @param {Request} req The request object
	* @returns {Promise <Response>} A promise which wil either respond with the live resource or throw
	*/
	fromNetwork: req =>
		Promise.resolve(urlPath(req.url)) // Calculate the usable URL - i.e. strip the hashbang
			// Fetch resource + open a handle to the resource cache {{{
			.then(url => Promise.all([
				Promise.resolve(url),

				// Make the request
				fetch(req), // Request the original resource (i.e. don't rewrite the URL)

				// Open a cache handle (so we can check if the entity needs updating)
				caches.open('resources'),
			]))
			// }}}
			// Check if the resource is being cached {{{
			.then(res => self.keyVal.has('resources', res[0], {raw: true})
				.then(isCached => ({
					isCached,
					url: res[0],
					response: res[1],
					cache: res[2],
				}))
			)
			// }}}
			// Optionally update the cached resource (in the background) ; return the response {{{
			.then(session => {
				if (session.isCached) {
					return session.cache.put(session.response) // Update local image of the resource (dont wait for it to complete)
						.then(()=> debug('> Updated local cached resource', session.response.url, session.response))
						.then(()=> session.response)
						.catch(()=> session.response); // Respond with the output even if we failed to stash locally
				} else {
					return session.response;
				}
			}),
			// }}}
};

self.addEventListener('fetch', event => event.respondWith(self.serve.fromAny(event.request)));
// }}}

// resolveResources() - Return a flattened list of resources we need to fetch {{{
/**
* Return a flattened, resolved list of resources (if !force: once, memorized)
*
* NOTE: For speed this function also decorates each response with:
*
* 	- `matcher` (Object) list of RegExps used to match various expressions
* 	- `matcher.collectionCount` Determine if a URL is querying against this collection in count mode
* 	- `matcher.collectionCreate` Determine if a URL is creating a new document within the collection
* 	- `matcher.collectionUpdate` Determine if a URL is updating an existing document within the collection
* 	- `matcher.collectionQuery` Determine if a URL is querying against this collection (so r.test() can be used when trying to find a corresponding collection in self.serve.fromCache)
* 	- `itemMatcher` (RegExp) on all collections, this can be applied to each URL in the cache to determine if this item is its origin parent
*
* @param {boolean} [force=false] Force a refetch from the server, if falsy and a response already exists in memory it is used instead
* @returns {Promise <array>}
*/
self.resolveResources = (force = false) => {
	if (!force && self.resolveResources.cached) return Promise.resolve(self.resolveResources.cached);

	debug('Requesting resource list');
	return self.keyVal.get('meta', 'packages', []) // Request subscribed packages
		// Resolve all depdencies by walking down each dependency tree until we see a visited node {{{
		.then(subscribed => {
			var pkgById = config.packages.reduce((t, pkg) => { // Transform into fast-access object
				t[pkg.id] = pkg;
				return t;
			}, {});

			var needPkgs = new Set();
			var seenPkgs = new Set();
			var addPreReq = ids => { // Scan recursivly down an array of prerequisite ids
				if (!ids) return;
				ids.forEach(id => {
					if (seenPkgs.has(id)) return; // Already iterated
					seenPkgs.add(id);
					needPkgs.add(id);
					addPreReq(pkgById[id].prereq);
				});
			};

			// Start initial scan
			addPreReq(subscribed);

			return Array.from(needPkgs).map(id => pkgById[id].payload);
		})
		// }}}
		// Flatten dependencies down to the .payload section {{{
		.then(pkgs => flatten(pkgs))
		// }}}
		// Decorate resources with meta fields {{{
		.then(resources => resources.map(resource => {
			if (resource.type == 'collection') resource.matcher = {
				collectionCount: (resource.count === undefined || resource.count) && new RegExp(
					'^'
					+ location.origin
					+ escapeRegExp(resource.item).replace(/\/\\{\\{id\\}\\}/, '\/count')
				),
				collectionCreate: resource.create && new RegExp(
					'^'
					+ location.origin
					+ escapeRegExp(resource.item).replace(/\/\\{\\{id\\}\\}/, '\/?$')
				),
				collectionPost: resource.update && new RegExp(
					'^'
					+ location.origin
					+ escapeRegExp(resource.item).replace(/\\{\\{id\\}\\}/, '(.+?)')
				),
				collectionQuery: (resource.query === undefined || resource.query) && new RegExp(
					'^'
					+ location.origin
					+ escapeRegExp(resource.item).replace(/\/?\\{\\{id\\}\\}/, '(.+?)')
				),
				item: new RegExp(
					'^'
					+ location.origin
					+ escapeRegExp(resource.item).replace(/\\{\\{id\\}\\}/, '(.+?)')
				),
			};

			if (resource.type == 'searchable') resource.matcher = {
				searchableSearch: new RegExp(
					'^'
					+ location.origin
					+ escapeRegExp(resource.item).replace(/\\{\\{query\\}\\}/, '(.+?)')
				)
			};

			return resource;
		}))
		// }}}
		// End - Cache resource response {{{
		.then(resources => {
			self.resolveResources.cached = resources;
			return resources;
		})
		.catch(e => Promise.reject('Resolved resources not available'))
		// }}}
};
// }}}

// syncCompleted(resources) - Announce completion of sync {{{
self.syncCompleted = (resources = []) => {
	return self.send('syncStatus', 'finished', resources.length, resources.length)
		.then(()=> self.keyVal.set('meta', 'lastSync', {date: (new Date).toISOString()}))
		.then(()=> debug('Sync completed'))
		.then(()=> self.stats().then(stats => self.send('syncStats', stats))); // Recompute stats in background
};
// }}}

// syncResources(cache, resources, attempt) - Performs sync on a list of resources {{{
self.syncResources = (cache, resources, attempt = 0) => {
	debug('Need to sync', resources.length, 'resources', attempt, 'attempts');
	if (!navigator.onLine || !resources.length) return self.syncCompleted(resources); // Nothing to do

	// Fetch all resource URL's we have left
	self.send('syncStatus', (attempt > 0)?'retrying':'syncing', resources.length, 0);
	var attempted = 0; // Tracker for how many items have been fetched - as they complete
	var failures = []; // List of failed resources
	return Promise.allLimit(config.fetchConcurrent || 3,
		resources.map(resource => () =>
			fetchRetry(resource.url)
				.then(res => {
					if (!res.ok) throw new Error(res.statusText);
					if (!resource.rewrite) return res;
					console.log(`Run rewriters on ${resource.url}`, resource.rewrite);
					return Promise.allSeries(
						resource.rewrite.map(rewriter => ()=> {
							if (!self.rewriters[rewriter.id]) throw new Error(`Rewriter "${rewriter.id}" is invalid`);
							return Promise.resolve(self.rewriters[rewriter.id](res, rewriter))
								.then(result => res = result);
						})
					).then(()=> res);
				})
			.then(res => cache.resources.put(urlPath(resource.url), res)) // Stripping querystrings
			.catch(err => {
				failures.push(resource);
				debug('Failed to download resource', resource.url, 'Err:', err.message, failures.length);
			})
			.finally(()=> self.send('syncStatus', (attempt > 0)?'retrying':'syncing', resources.length, ++attempted))
	))
	.then(items => {
		// TODO: Fail after X attempts? Refreshing browser will force "stop".
		if (navigator.onLine && failures.length) return setTimeout(() => self.syncResources(cache, failures, ++attempt), 10000 * attempt); // Delay with slight back-off.
		return self.syncCompleted(items);
	});
};
// }}}

// sync() - internal function to activate the sync event {{{
/**
* When we last performed a sync operation
* @var {Date}
*/
self.lastSync;

/**
* Handler promise if a sync is already in progress
* @var {Promise}
*/
self.syncPromise;

/**
* Perform a sync cycle
* @returns {Promise}
*
* @emits syncStatus Emitted as (stage, totalItems, synced) When performing a sync status. stage ENUM: 'started', 'posting', 'syncing', 'finished'
* @emits syncStats Emitted as an object containing cache stats. See stats() for the return details
*/
self.sync = ()=> {
	if (self.syncPromise) return self.syncPromise;
	if (!navigator.onLine) return Promise.reject('Not online - unable to sync');

	/**
	* Handle for caches to use when stashing request / resource pairs
	* @var {Object}
	*/
	var cache = {};

	return self.syncPromise = Promise.resolve()
		.then(()=> debug('Begin sync'))
		// Open cache handles {{{
		.then(()=> self.send('syncStatus', 'started'))
		.then(()=> Promise.all([ // Stash cache object reference for later
			caches.open('resources').then(res => cache.resources = res),
			caches.open('posts').then(res => cache.posts = res),
		]))
		// }}}
		// Process all pending posts {{{
		.then(caches => {
			var processed = 0; // How many documents have been processed
			var passCount = 0; // How many recursive cycles have we iterated
			var putRefs = {}; // Lookup object for created => real references

			/**
			* Perform repeated passes over all post requests stashing the 'real' server provided Ids for anything marked that looks like the _id was created with `mkId()`
			* In addition, scan the documents body (recursively) for references for references to anything that looks like it uses mkId() and only post those when we can resolve all references
			* This SHOULD mean that posts to the server use the server provided ID's even if we temporarily created the document using a fake ID internally
			*/
			return new Promise((resolve, reject) => {
				var processPosts = () =>
					Promise.resolve()
						.then(()=> self.keyVal.list(cache.posts))
						.then(urls => {
							if (!urls.length) // Finished processing everything - resolve outer promise
								return resolve();
							debug('Processing CACHES: ', caches.length, ', POSTS: ', urls.length, ', PASS: ', '#' + ++passCount);
							return urls;
						})
						.then(urls => Promise.all(urls.map(url =>
							self.keyVal.get(cache.posts, url, {}) // Fetch the post body
								.then(body => {
									// Walk over body and replace things that look like MkId()'s with the server provided refs from a previous cycle {{{
									var needRefs = []; // List of references to mkId like refs that we can't resolve
									var replacedRefsCount = 0;
									var walkBody = (node, parent, key) => {
										if (!node) return; // Skip empty nodes
										if (Array.isArray(node)) { // Interate into arrays
											node.forEach((n, i) => walkBody(n, node, i));
										} else if (typeof node == 'object') { // Iterate into objects (via their keys)
											Object.keys(node).forEach(k => walkBody(node[k], node, k));
										} else if (key !== '_id' && typeof node == 'string' && isMkId(node)) { // Is a made up ID?
											if (!putRefs[node]) { // We don't have a ref yet for this item
												needRefs.push(node);
											} else { // We can resolve this value
												debug(`DEBUG: Can resolve ref ${node} (as '${putRefs[node]}')`);
												parent[key] = putRefs[node];
												replacedRefsCount++;
											}
										} // Implied else (numbers, undefined, null etc) - don't do anything
									};
									walkBody(body); // Kick off intial iteration
									// }}}

									if (needRefs.length) {
										debug(`Cannot create document ${url} in pass #${passCount}, requires references:`, needRefs);
									} else { // Body requires no more dependcies in this pass - create it and remove it from the post cache

										// Strip URL of temporary "NEW" ID before sending to server.
										var origUrl = url;
										if (body._id && isMkId(body._id) && url.indexOf('NEW-') !== -1) {
											url = url.substring(0, url.lastIndexOf('/'));
										}

										return fetch(url, {
											method: 'POST',
											cache: 'no-cache',
											headers: {'Content-Type': 'application/json; charset=utf-8'},
											body: JSON.stringify(body._id && isMkId(body._id) ? omit(body, '_id') : body),
										})
											.then((res)=> { // Was it a meta-document - stash the server provided ID against our fake one
												if (!res.ok) debug('Sync response invalid: ', res);

												if (body._id && isMkId(body._id)) {
													return res.json()
														.then(createdBody => {
															debug('DEBUG: Got back real ID', createdBody._id, 'for the internal mkId', body._id);
															// Take another pass to resolve IDs after creation
															putRefs[body._id] = createdBody._id;
														});
												}
											})
											.then(()=> self.keyVal.unset(cache.posts, origUrl)) // Remove the post from the cache
											.then(()=> replacedRefsCount > 0 && self.keyVal.unset(cache.resources, origUrl)) // Remove this (wrong) entity from the resource cache if it had any MkIds present
											.then(()=> self.send('syncStatus', 'posting', ++processed, urls.length))
									}
								})
						)))
						.then(()=> { // Keep cycling until we get an empty list of items remaining
							if (passCount >= config.maxPostCycles) throw new Error(`Exhausted maximum number of ${config.maxPostCycles} maximum POST scan cycles`);
							processPosts();
						})
						.catch(reject);

				processPosts();
			});
		})
		// }}}
		// Fetch resources to cache offline {{{
		.then(()=> self.resolveResources())
		// }}}
		// Gather a list of resources to cache {{{
		// NOTE: Each object should return an array of promises of endpoint resources to cache in the form {url}
		.then(resources => {
			var fetchCache = {}; // Object cache for fetchThrottled

			return Promise.all([
				// Cache basic 'simple' url resources (type=url) {{{
				// We only need to cache these if they are missing as the SW updates future requests to them anyway
				Promise.all(
					resources
						.filter(r => r.type == 'url')
						.map(r => self.keyVal.has(cache.resources, urlPath(r.url), {raw: true}).then(exists => ({exists, ...r})))
				)
					.then(resources => resources.filter(r => !r.exists))
					.then(resources => {
						debug('Caching', resources.length, 'binary URL resources');
						return resources;
					}),
				// }}}

				// Cache collection items (type=collection) {{{
				// TODO: Set `collection.index` to `_id` or `id` once and use that throughout.
				// TODO: Encapsulate duplication
				Promise.allLimit(config.fetchConcurrent,
					resources
						.filter(r => r.type == 'collection')
						.map(collection => ()=> {
							debug('Fetching collection data for', collection.url, ' by ', collection.item, collection.index || '_id');
							return fetchThrottled(fetchCache, collection.url, {
								json: true,
								once: items => self.keyVal.set('indexes', collection.item, items.map(i => i[collection.index] || i._id)).then(()=> items),
							})
								.then(items => Promise.all(items.map(item => { // Check each resource and see if needs updating - if so add it to the list of things to grab
									var placeholder = '{{id}}';
									if (typeof collection.index !== 'undefined') placeholder = '{{' + collection.index + '}}';
									// TODO: Regex could extract index field from `collection.item`. No need for `collection.index`.
									var url = collection.item.replace(placeholder, item[collection.index] || item._id || item.id || '');
									return self.keyVal.get('resources', url)
										.then(existing => {
											if (item.__v === null && (!existing || existing.__v === null)) { // Both versions have never been touched
												return false;
											} else if (typeof item.__v !== 'undefined' && typeof item.__v != 'number') {
												debug('Version for resource', url, 'is non-numeric', item);
												return false;
											} else if (!existing || typeof existing.__v !== 'undefined' && existing.__v < item.__v) { // No local or server item is newer
												return {url};
											} else { // Local is up-to-date
												return false;
											}
										})
								})))
								.then(items => items.filter(i => i)); // Remove defunct / already-in-sync
						})
				)
					.then(items => flatten(items)),
				// }}}

				// Cache collection items as binary (type=collectionBinary) {{{
				// TODO: Encapsulate duplication
				Promise.allLimit(config.fetchConcurrent,
					resources
						.filter(r => r.type == 'collectionBinary')
						.map(collection => ()=> {
							debug('Fetching binary collection data for', collection.url, ' by ', collection.item, collection.index || '_id');
							return fetchThrottled(fetchCache, collection.url, {
								json: true,
								once: items => self.keyVal.set('indexes', collection.item, items.map(i => i[collection.index] || i._id)).then(()=> items),
							})
								.then(items => Promise.all(items.map(item => { // Check each resource and see if it exists, if it does ignore (manual pulls with an internet connection will refresh anyway)
									var placeholder = '{{id}}';
									if (typeof collection.index !== 'undefined') placeholder = '{{' + collection.index + '}}';
									var url = collection.item.replace(placeholder, item[collection.index] || item._id || item.id || '');
									return self.keyVal.has('resources', url, {raw: true})
										.then(exists => exists ? false : {url})
								})))
								.then(items => items.filter(i => i)); // Remove defunct / already-in-sync
						})
				)
					.then(items => flatten(items)),
				// }}}

				// Cache 'searchable'' url resources (type=searchable) {{{
				Promise.all(
					resources
						.filter(r => r.type == 'searchable')
						.map(r => self.keyVal.has(cache.resources, urlPath(r.url), {raw: true}).then(exists => ({exists, ...r})))
				)
					.then(resources => resources.filter(r => !r.exists))
					.then(resources => {
						debug('Caching', resources.length, 'search URL resources');
						return resources;
					}),
				// }}}

			]);
		})
		.then(cacheLists => flatten(cacheLists))
		// }}}
		// Sync resources that we dont have or are outdated {{{
		// FIXME: Pass through `cache` or look it up again?
		.then(items => self.syncResources(cache, items))
		// }}}
		.finally(()=> self.syncPromise = false) // Unbind from the promise listener
		.catch(e => debug('Sync error', e))
};
// }}}

// installAutoSync() - Auto sync poller and worker {{{
self.installAutoSyncTimer;

/**
* Install the autoSync timer
* If a sync occurs the timer handle is released and this function recalled
*/
self.installAutoSync = ()=> {
	if (!config.autoSyncFirst) return; // AutoSync disabled

	var autoSync = ()=> {
		clearTimeout(self.installAutoSyncTimer); // Prevent timer collisions;
		self.sync()
			.then(()=> self.installAutoSyncTimer = setTimeout(autoSync, config.autoSyncPollingOnline))
			.catch(()=> self.installAutoSyncTimer = setTimeout(autoSync, config.autoSyncPollingOffline))
	};

	self.installAutoSyncTimer = setTimeout(autoSync, config.autoSyncFirst);
};
// }}}

// clean() - Remove orphaned indexes + documents [CONDITIONAL INCLUDE] {{{
/* @if compile.clean */
/**
* Clean up orphaned entities, abandoned collections etc.
* @param {boolean} [force=false] Whether to use the idle method (only clean every config.cleanInterval) or force a clean
* @returns {Promise} A promise which will resolve with stats on what was done (set set as `meta/lastClean` key)
*/
self.clean = (force = false) => {
	var session = {
		knownIndexes: undefined,
		cacheHandles: {
			resource: undefined,
			indexes: undefined,
		},
		serverResources: undefined,
		stats: {
			removedCollections: 0,
			removedDocs: 0,
		},
	};

	return Promise.resolve()
		// If (!force) check that we can proceed or throw {{{
		.then(()=> {
			if (!force) {
				self.keyVal.get('meta', 'lastClean')
					.then(data => new Date(data.date))
					.then(lastClean => {
						if (lastClean >= new Date(Date.now() - config.cleanInterval)) throw new Error('STOP');
					})
			}
		})
		// }}}
		// Fetch data we will need {{{
		.then(()=> Promise.all([ // Open handles
			caches.open('indexes').then(res => session.cacheHandles.indexes = res),
			caches.open('resources').then(res => session.cacheHandles.resources = res),
			self.resolveResources().then(data => session.serverResources = data),
		]))
		.then(()=> Promise.all([ // Fetch data from handles
			self.keyVal.list(session.cacheHandles.indexes).then(data => session.knownIndexes = data),
		]))
		// }}}
		// Clean unknown indexes {{{
		.then(()=> {
			var unknownIndexes = new Set(session.knownIndexes);

			session.serverResources
				.filter(resource => resource.type == 'collection')
				.forEach(resource => unknownIndexes.remove(resource.url));

			debug('FIXME: CLEAN INDEXES', unknownIndexes);

			var removeKeys = Array.from(unknownIndexes);
			session.stats.removedCollections = removeKeys.length;

			return Promise.all(
				// Remove dead indexes
				removeKeys.map(k => self.keyVal.unset(session.cacheHandles.indexes, k)),

				// Remove associated keys
				Promise.all(removeKeys.map(k => {
					var urlmatcher = new RegExp(k.replace('{{id}}', '.+?'));
					debug('FIXME: Removing all entries matching', urlMatcher);
					return self.keyVal.list(session.cacheHandles.resources, i => urlMatcher.test(i.url))
						.then(docKeys => Promise.all(
							docKeys.map(dk => self.keyVal.unset(session.cacheHandles.resources, dk))
						))
				})),
			);
		})
		// }}}
		// Delete orphaned documents {{{
		.then(()=> {
			debug('FIXME: Clean: stub - remove orphaned documents');
			// FIXME: Presumably need to pull in lists of each collection, compare to resource list and purge unknown
		})
		// }}}
		.then(()=> self.keyVal.set('meta', 'lastClean', {date: (new Date).toISOString()}))
		.then(()=> session.stats)
};
/* @endif */
// }}}

// stats() - Recompute stats about the cache {{{
/**
* Recompile stats about the cache
* @returns {Promise <Object>} A promise resolving to {quota, usage, usagePercent, itemCount, lastSync}
*/
self.stats = ()=>
	Promise.resolve()
		.then(()=> caches.open('resources')) // Get a handle to the cache
		.then(cache => Promise.all([
			// Get cache itemCount {{{
			cache.keys().then(keys => keys.length),
			// }}}
			// Get storage quota / usage {{{
			navigator.storage.estimate(),
			// }}}
			// Fetch the last sync meta information {{{
			self.keyVal.get('meta', 'lastSync', false),
			// }}}
			// Fetch packages we are syncing against {{{
			self.keyVal.get('meta', 'packages', []),
			// }}}
		]))
		.then(stats => ({
			itemCount: stats[0],
			lastSyncDate: stats[2].date,
			usage: stats[1].usage,
			quota: stats[1].quota,
			usagePercent: Math.ceil(stats[1].usage / stats[1].quota * 100),
			packages: stats[3],
			forceOffline: config.forceOffline,
		}));
// }}}

// setPackages() {{{
/**
* Set the packages to sync by ID
* @param {array <string>} packages The packages to sync
* @return {Promise} A promise representing when the package set is complete
*/
self.setPackages = packages =>
	Promise.resolve()
		.then(()=> debug('Set packages', packages))
		.then(()=> self.keyVal.set('meta', 'packages', packages))
		.then(()=> self.resolveResources.cached = undefined); // Invalidate the resource cache
// }}}

// Event relay - create the utility on() / send() functions {{{
/**
* Send a message to all connected clients
* @param {string} event The event to dispatch
* @param {*} [args...] Optional arguments to send
* @returns {Promise} Promise which will resolve when all events are dispatched
*/
self.send = (event, ...args) =>
	self.clients.matchAll()
		.then(clients => Promise.all(clients.map(client =>
			client.postMessage({event, args})
		)));

/**
* Register against a message
* @param {string} event The event to respond to
* @param {function} cb The callback to call with arguments when the message is recieved
* @returns {Object} The chainable ServiceWorker instance
*/
self.on = (event, cb) => {
	self.addEventListener('message', e => {
		var envelope = e.data;
		if (typeof envelope !== 'object' || !envelope.event || !envelope.args) return; // Doesn't look like one of our messages
		if (envelope.event != event) return; // Not our event

		cb.apply(self, envelope.args);
	});

	return self;
};


self.on('setPackages', packages => self.setPackages(packages));
self.on('sync', ()=> {
	debug('Got request: Sync!');
	return self.sync();
});
self.on('stats', ()=> self.stats().then(stats => self.send('syncStats', stats)));
self.on('ping', ()=> self.send('pong'));
self.on('pong', ()=> debug('BACKEND PONG!'));

self.on('forceOfflineToggle', ()=> {
	if (config.forceOffline) {
		debug('Disable forced offline mode');
		config.forceOffline = false;
		self.keyVal.unset('meta', 'flags/forceOffline')
			.then(()=> self.stats().then(stats => self.send('syncStats', stats)))
	} else {
		debug('Forcing offline mode');
		config.forceOffline = true;
		self.keyVal.set('meta', 'flags/forceOffline', {enabled: true})
			.then(()=> self.stats().then(stats => self.send('syncStats', stats)))
	}
});
// }}}

// keyVal.* - Key / Val storage {{{
self.keyVal = {
	/**
	* Use the cache system to fetch a JSON object by a key
	* @param {string|Object} cache The cache name or handle to store the value within
	* @param {string} key The key to store against
	* @param {*} [fallback] The vallback value to use if the key is not found
	* @param {Object} [options] Additional options to pass
	* @param {boolean} [options.raw] Allow retrieval of non-JSON objects
	* @returns {Promise} A promise which will resolve with the fetched value (or the fallback)
	*/
	get: (cache, key, fallback, options) =>
		Promise.resolve(typeof cache == 'string' ? caches.open(cache) : cache)
			.then(cache => cache.match(key))
			.then(res =>
				options && options.raw ? res || fallback // Want raw object
				: res.json() // Want JSON
			)
			.catch(()=> fallback),

	/**
	* Returns if a given URL is present within the cache
	* This is really just a thin wrapper around `get()`
	* @param {string|Object} cache The cache name or handle to check the value with
	* @param {string} key The key to check the existance of
	* @param {Object} [options] Additional options to pass
	* @param {boolean} [options.raw] Allow checking non-JSON objects
	* @returns {Promise} A promise which will resolve with a boolean indicating if the key exists
	*/
	has: (cache, key, options) =>
		self.keyVal.get(cache, key, false, options)
			.then(res => res !== false),

	/**
	* Use the cache system to store a JSON object to be retrieved later
	* @param {string|Object} cache The cache name or handle to fetch the value from
	* @param {string} key The key to store against
	* @param {*} val The value to store, this must be a non-circular and JSON encodable string - e.g. Dates need manually convverting to objects later
	* @return {Promise} A promise which will resolve with the originally supplied value
	*/
	set: (cache, key, val) =>
		Promise.resolve(typeof cache == 'string' ? caches.open(cache) : cache)
			.then(cache => cache.put(key, new Response(JSON.stringify(val), {headers: {'Content-Type': 'application/json'}})))
			.then(()=> val),


	/**
	* Release a cache key
	* @param {string|Object} cache The cache name or handle to remove the key from
	* @param {string} key The key to remove
	* @return {Promise} A promise which will resolve when the item is removed
	*/
	unset: (cache, key) =>
		Promise.resolve(typeof cache == 'string' ? caches.open(cache) : cache)
			.then(cache => cache.delete(key)),

	/**
	* Search a cache contents for a match
	* NOTE: Because this only really fetches the top level information querying by things like the JSON body contents is not possible
	* @param {string|Object} cache The cache name or handle to fetch the contents from
	* @param {function} [matcher] The search to run on each item, commonly used as `m => m.url == '/some/url'`
	* @return {Promise} A promise which will return an array of strings of the found cache values
	*/
	list: (cache, matcher) =>
		Promise.resolve(typeof cache == 'string' ? caches.open(cache) : cache)
			.then(cache => cache.keys())
			.then(items => matcher ? items.filter(matcher) : items)
			.then(items => items.map(i => i.url)),
};
// }}}

// Rewriters {{{
self.rewriters = {
	/* @if compile.rewriters.htmlHeadScripts */
	/**
	* Move all <script> tags within a HTML resource into the header
	* @param {Response} res The response object to mutate
	* @param {Object} [options] Additional options to pass
	* @param {array <string>} [options.priority] Optional sort priorities to use, options given values based on the index of the array +1 (so position 0 = priority 0), everything else is -1, each entry is evaluated as a match-anywhere RegExp
	* @param {boolean} [removeAsync=false] Remove any async attributes in each script tag
	* @param {boolean} [removeDefer=false] Remove any defer attributes in each script tag
	* @returns {Response} The mangled response object
	*
	* @example Move all script tags to <head/> and reorder so that vendors.min.js + app.min.js are the last two scripts to run
	* {rewrite: {id: 'htmlHeadScripts', priority: ['vendors.min.js', 'app.min.js']}}
	*/
	htmlHeadScripts: (res, options) =>
		res
			.text()
			.then(body => {
				var scripts = [];

				// Remove script elements
				body = body.replace(/(<script.+?>.*?<\/script>)/g, contents => {
					scripts.push(contents);
					return '';
				})

				if (options && options.priority) {
					var priorityRegExps = options.priority.map(p => new RegExp(p));

					scripts = scripts // Sort by extracted priority position
						.map(script => ({script, val: priorityRegExps.findIndex(p => p.test(script))}))
						.sort((a, b) =>
							a.val == b.val ? 0
							: a.val > b.val ? 1
							: -1
						)
						.map(script => script.script)
				}

				if (options && options.removeAync) scripts = scripts.map(s => s.replace(/\basync\b/, ''));
				if (options && options.removeDefer) scripts = scripts.map(s => s.replace(/\bdefer\b/, ''));

				// Return the mangled body contents replacing the closing head tag with the sorted scripts
				return new Response(
					new Blob([
						body.replace('</head>', ()=> scripts.join('') + '</head>')
					]),
					{
						headers: res.headers,
					},
				);
			}),
	/* @endif */

	/* @if compile.rewriters.replace */
	/**
	* Generic text replacment
	* @param {Response} res The response object to mutate
	* @param {Object} options Additional options to pass
	* @param {string} options.match The matching string to replace
	* @param {string} options.replacement The string to replace with
	* @returns {Response} The mangled response object
	*
	* @example Replace Foo with Bar in an input
	* {rewrite: {id: 'replace', match: 'foo', replacement: 'bar'}}
	*/
	replace: (res, options) => {
		if (!options || !options.match || options.replacement === undefined) throw new Error(`Replace rewriter options.{match,replacement} must be specified for ${res.url}`);
		return res
			.text()
			.then(body => body.replace(options.match, options.replacement))
			.then(body => new Response(
				new Blob([body], { headers: res.headers})
			));
	},
	/* @endif */

	/* @if compile.rewriters.headers */
	/**
	* Force set headers of a response
	* @param {Response} res The response object to mutate
	* @param {Object} options Additional options to pass
	* @param {string} options.headers An object of headers to merge
	* @returns {Response} The mangled response object
	*
	* @example Force set the content type to JSON
	* {rewrite: {id: 'headers', headers: {'Content-Type': 'application/json'} }}
	*/
	headers: (res, options) => {
		if (!options || !options.headers) throw new Error(`Header rewriter options.headers must be specified for ${res.url}`);

		return res
			.blob()
			.then(body => new Response(body, {headers: options.headers}))
	},
	/* @endif */
};
// }}}

// External imports {{{

// jqDeserialize {{{
/**
* Deserialize a parameter string compatible with jQ / Angular (jqLike) and body-parser
* @param {string} url The URL to deserialize
* @returns {Object} A nested object of the extracted values
* @see https://github.com/edwardsmit/node-qs-serialization/blob/master/lib/deparam.js
*/
var jqDeserialize = function(params, coerce) {
	var obj = {};
	var coerceTypes = {
		true: !0,
		false: !1,
		null: null,
	};

	if (typeof params !== 'string') {
		return obj;
	}
	if (typeof coerce === 'undefined') {
		coerce = true;
	}

	function safeDecodeURIComponent(component) {
		var returnvalue = '';
		try {
			returnvalue = decodeURIComponent(component);
		} catch (e) {
			returnvalue = unescape(component);
		}
		return returnvalue;
	}

	// Iterate over all name=value pairs.
	params.replace(/\+/g, ' ').split('&').forEach(function(element) {
		var param = element.split('=');
		var key = safeDecodeURIComponent(param[0]);
		var val;
		var cur = obj;
		var i = 0;

		// If key is more complex than 'foo', like 'a[]' or 'a[b][c]', split it
		// into its component parts.
		var keys = key.split('][');
		var keysLast = keys.length - 1;

		// If the first keys part contains [ and the last ends with ], then []
		// are correctly balanced.
		if (/\[/.test(keys[0]) && /\]$/.test(keys[keysLast])) {
			// Remove the trailing ] from the last keys part.
			keys[keysLast] = keys[keysLast].replace(/\]$/, '');
			// Split first keys part into two parts on the [ and add them back onto
			// the beginning of the keys array.
			keys = keys.shift().split('[').concat(keys);
			keysLast = keys.length - 1;
		} else {
			// Basic 'foo' style key.
			keysLast = 0;
		}
		// Are we dealing with a name=value pair, or just a name?
		if (param.length === 2) {
			val = safeDecodeURIComponent(param[1]);
			// Coerce values.
			if (coerce) {
				val = val && !isNaN(val)           ? +val             // number
					: val === 'undefined'            ? undefined        // undefined
					: coerceTypes[val] !== undefined ? coerceTypes[val] // true, false, null
					: val;                                              // string
			}
			if (keysLast) {
				// Complex key, build deep object structure based on a few rules:
				// * The 'cur' pointer starts at the object top-level
				// * [] = array push (n is set to array length), [n] = array if n is
				//   numeric, otherwise object.
				// * If at the last keys part, set the value.
				// * For each keys part, if the current level is undefined create an
				//   object or array based on the type of the next keys part.
				// * Move the 'cur' pointer to the next level.
				// * Rinse & repeat.
				for (; i <= keysLast; i++) {
					key = keys[i] === '' ?
						cur.length :
						keys[i];
					cur = cur[key] = i < keysLast ?
						cur[key] || (keys[i + 1] && isNaN(keys[i + 1]) ?
							{} :
							[]
						) : val;
				}
			} else {
				// Simple key, even simpler rules, since only scalars and shallow
				// arrays are allowed.
				if (Array.isArray(obj[key])) {
					// val is already an array, so push on the next value.
					obj[key].push(val);
				} else if (obj[key] !== undefined) {
					// val isn't an array, but since a second value has been specified,
					// convert val into an array.
					obj[key] = [
						obj[key],
						val
					];
				} else {
					// val is a scalar.
					obj[key] = val;
				}
			}
		} else if (key) {
			// No value was defined, so set something meaningful.
			obj[key] = coerce ? undefined : '';
		}
	});
	return obj;
};
// }}}

// }}}
