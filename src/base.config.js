/* Example @momsfriendlydevco/offline config setup */
module.exports = {
	enabled: false,
	cleanInterval: 1000 * 60 * 60 * 3, // 3h
	debug: true,
	debugFailures: true, // Cache all failure requests in caches/failures
	debugPrefix: '[OSW]',
	fetchOptions: {credentials: 'include', headers: {accept: 'application/json'}},
	fetchAttempts: 10, // Number of retry attempts before failing sync on network errors
	fetchConcurrent: 3, // Number of concurrent requests allowed by Promise.allLimit
	forceOffline: false, // If true, treat all incomming connections as offline (inherited from `caches/meta/flags/forceOffline{enabled: true}` if its present)
	autoSyncFirst: 1000 * 10, // 10s, period until first sync (falsy to disable)
	autoSyncPollingOnline: 1000 * 60, // 1m, how long to wait between polls after the first sync when we are online
	autoSyncPollingOffline: 1000 * 30, // 30s, how long to wait between polls after the first sync when we are offline
	ignore: [ // List of RegExps to skip caching for (these have to be strings to survive JSON encoding)
		'^\/login', '^\/logout', '^\/api\/session\/login', // Refuse to cache session specific functionality
		'^\/build\/app\.', // Don't cache app build files - when debugging we need to repull these in case any front-end resources change their behaviour
	],
	maxPostCycles: 10, // Maximum number of recursive post attempts before giving up, set this to the ideal depth of A creates B creates C style loops that are possible
	compile: {
		clean: false, // FIXME: Still needs development
		rewriters: {
			headers: false,
			htmlHeadScripts: false,
			replace: false,
		},
	},
	packages: [ // Example package configuration - replace this with your own
		{
			id: 'base',
			title: 'Base',
			advanced: true,
			description: 'The base offline package - this is needed for all offline functionality',
			payload: [
				// Root HTML
				{type: 'url', url: '/'},

				// JS / CSS resources:
				{type: 'url', url: '/build/vendors-core.min.css'},
				{type: 'url', url: '/build/vendors-core.min.js'},
				{type: 'url', url: '/build/vendors-main.min.js'},
				{type: 'url', url: '/build/vendors-main.min.css'},
				{type: 'url', url: '/build/vendors-fonts.min.css'},
				{type: 'url', url: '/build/app.min.js'},
				{type: 'url', url: '/build/app.min.css'},
				{type: 'url', url: '/build/partials.min.js'},

				// Data resources:
				{type: 'url', url: '/api/offline/packages'},
				{type: 'url', url: '/api/session/profile'},

				// Logos:
				{type: 'url', url: '/build/assets/logo.png'},

				// Favicons:
				// FIXME: This asset is missing on pebbles?
				//{type: 'url', url: '/build/assets/favicon-128.png'},
				{type: 'url', url: '/build/assets/apple-icon-57x57.png'},
				{type: 'url', url: '/build/assets/apple-icon-60x60.png'},
				{type: 'url', url: '/build/assets/apple-icon-72x72.png'},
				{type: 'url', url: '/build/assets/apple-icon-76x76.png'},
				{type: 'url', url: '/build/assets/apple-icon-114x114.png'},
				{type: 'url', url: '/build/assets/apple-icon-120x120.png'},
				{type: 'url', url: '/build/assets/apple-icon-144x144.png'},
				{type: 'url', url: '/build/assets/apple-icon-152x152.png'},
				{type: 'url', url: '/build/assets/apple-icon-180x180.png'},
				{type: 'url', url: '/build/assets/android-icon-192x192.png'},
				{type: 'url', url: '/build/assets/favicon-32x32.png'},
				{type: 'url', url: '/build/assets/favicon-96x96.png'},
				{type: 'url', url: '/build/assets/favicon-16x16.png'},
				{type: 'url', url: '/build/assets/ms-icon-144x144.png'},

				// Fonts:
				{type: 'url', url: '/build/fonts/fa-brands-400.woff2'},
				{type: 'url', url: '/build/fonts/fa-light-300.woff2'},
				{type: 'url', url: '/build/fonts/fa-regular-400.woff2'},
				{type: 'url', url: '/build/fonts/fa-solid-900.woff2'},
				{type: 'url', url: '/build/fonts/moms-friendly-font.woff'},
				{type: 'url', url: '/build/fonts/OpenSans-Light.ttf'},
				{type: 'url', url: '/build/fonts/OpenSans-Bold.ttf'},
				{type: 'url', url: '/build/fonts/OpenSans-Regular.ttf'},
				{type: 'url', url: '/build/fonts/OpenSans-SemiBold.ttf'},
			],
		},
		{
			id: 'users',
			title: 'Users',
			advanced: true,
			description: 'Basic user information',
			prereq: ['base', 'companies'],
			payload: [
				{type: 'url', url: '/api/users'},
				{type: 'collection', url: '/api/users?limit=0&select=_id,__v&status=active', item: '/api/users/{{id}}'},
				{type: 'collectionBinary', url: '/api/users?limit=0&select=_id,__v&status=active', item: '/api/session/avatar/{{id}}'},
			],
		},
	],
};
