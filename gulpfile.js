var gulp = require('@momsfriendlydevco/gulpy');
var rollup = require('rollup');

gulp.task('default', 'build');
gulp.task('build', 'build:serviceWorker');

gulp.task('build:serviceWorker', ()=> Promise.resolve()
	.then(()=> {
		var config = require('./src/base.config.js');

		if (process.env['OFFLINE_CONFIG_FILE']) {
			gulp.log('Using config from', gulp.colors.cyan(process.env['OFFLINE_CONFIG_FILE']));
			config = {...config, ...require(process.env['OFFLINE_CONFIG_FILE'])};
		} else {
			gulp.log(gulp.colors.yellow('WARN'), 'Env', gulp.colors.cyan('OFFLINE_CONFIG_FILE'), 'not specified. Using base config is likely to cause the service worker not to work correctly');
		}

		return JSON.stringify(config, null, '\t')
			.replace(/^\{/, '')
			.replace(/\}$/, ''); // Dump contents of config (stripping object warppers, as we are dumping inside existing braces)
	})
	.then(config => rollup.rollup({
		input: './src/offline.sw.js',
		inlineDynamicImports: true,
		plugins: [
			require('rollup-plugin-replace')({
				delimiters: ['/*@ ', ' @*/'],
				'OFFLINE_CONFIG': ()=> config,
			}),
			require('rollup-plugin-commonjs')({
				include: ['node_modules/**/*'],
			}),
			require('rollup-plugin-node-resolve')({
				mainFields: ['browser', 'module', 'main'],
				extensions: ['.js'],
			}),
			require('rollup-plugin-babel')({
				presets: [
					['@babel/env', {
						targets: {
							chrome: 75,
							firefox: 67,
						}
					}],
				],
				exclude: 'node_modules/**',
			}),
			/*
			require('rollup-plugin-babel-minify')({
				banner: '/' + '* @url https://github.com/MomsFriendlyDevCo/offline *' + '/',
				bannerNewLine: true,
				comments: false,
			}),
			*/
		],
	}))
	.then(bundle => {
		bundle.write({
			format: 'iife',
			file: './dist/offline.sw.js',
			name: 'offlineSW',
			sourcemap: true,
		});
	})
);
