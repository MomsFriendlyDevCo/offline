var gulp = require('@momsfriendlydevco/gulpy');
var rollup = require('rollup');

gulp.task('default', 'build');
gulp.task('build', 'build:serviceWorker');

gulp.task('build:serviceWorker', ()=>
	rollup.rollup({
		input: './src/offline.sw.js',
		inlineDynamicImports: true,
		plugins: [
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
			require('rollup-plugin-babel-minify')({
				banner: '/* @url https://github.com/MomsFriendlyDevCo/offline */',
				bannerNewLine: true,
				comments: false,
			}),
		],
	}).then(bundle => {
		bundle.write({
			format: 'iife',
			file: './dist/offline.sw.js',
			name: 'offlineSW',
			sourcemap: true,
		});
	})
);
