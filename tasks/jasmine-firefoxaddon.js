/*jslint node:true, nomen:true */
'use strict';

module.exports = function (grunt) {
  var http = require('http'),
    chalk = require('chalk'),
    path = require('path'),
    async = require('async'),
    fs = require('fs-extra'),
    pkg = require('../package.json');

  grunt.loadNpmTasks('grunt-mozilla-addon-sdk');


  function addFiles(files, to, tagFilter) {
    var tags = '';

    files.forEach(function (file) {
      file.src.forEach(function (f) {
        var dest;
        if (file.dest && grunt.file.isDir(file.dest)) {
          dest = f;
        } else {
          dest = file.dest || f;
        }
        if (grunt.file.isFile(f)) {
          if (grunt.file.isMatch(tagFilter, f)) {
            tags += "register(self.data.url('" + dest + "'));\n";
          }
          grunt.file.copy(f, to + '/data/' + dest);
        }
      });
    });

    return tags;
  }

  function cleanup(ctx) {
    var good = true;
    if (ctx.cleanupTimeout) {
      clearTimeout(ctx.cleanupTimeout);
    }

    if (!ctx.status) {
      grunt.fail.fatal(chalk.red('Timed out'));
      good = false;
    } else if (ctx.status.failed === 0) {
      grunt.log.ok(chalk.green('0 failures'));
    } else {
      grunt.log.error(chalk.red(ctx.status.failed + ' failures'));
      good = false;
    }

    ctx.web.close();
    grunt.file['delete'](ctx.outfile);

    return (good || new Error('One or more tests failed.'));
  }
  
  function buildSpec(ctx) {
    grunt.log.write('Building...');
    grunt.file.mkdir(ctx.outfile);
    var dest = ctx.outfile,
      tags = "";

    // Copy the template
    grunt.file.recurse(ctx.template, function (file, root, dir, filename) {
      grunt.file.copy(file, dest + '/' + filename);
    });
    // Copy Jasmine
    grunt.file.recurse(__dirname + '/../vendor/jasmine-core-' + ctx.version,
      function (file, root, dir, filename) {
        if (!dir) {
          dir = '';
        }
        grunt.file.copy(file, dest + '/lib/jasmine-core/' + dir + '/' + filename);
      });
    // Make a profile directory.
    grunt.file.mkdir(ctx.outfile + '/profile');

    // Copy user files.
    if (!ctx.paths) {
      ctx.paths = [];
      ctx.files.forEach(function (file) {
        ctx.paths = ctx.paths.concat(grunt.file.expand(file.src));
      });
    }
    tags += addFiles(ctx.files, dest, ctx.paths);

    tags += "finishLoad(" + ctx.port + ");";

    // Update the template with found specs.
    tags = grunt.file.read(dest + '/lib/main.js') + tags;
    grunt.file.write(dest + '/lib/main.js', tags);

    grunt.log.writeln(chalk.green('Done.'));
  }


  function startReporter(ctx) {
    ctx.cleanupTimeout = setTimeout(cleanup.bind({}, ctx), ctx.timeout);
    grunt.log.write('Starting Reporter...');

    ctx.messages = [];
    ctx.inprogress = '';
    ctx.web = http.createServer(function (req, res) {
      if (req.url === '/') {
        res.writeHead(200, {'Content-Type': 'text/html'});
        res.end('<html>' +
                'Reporting server for grunt-jasmine-firefoxaddon.' +
                '</html>');
      } else if (req.url === '/put') {
        req.setEncoding('utf8');
        req.on('data', function (chunk) {
          ctx.inprogress += chunk;
        });
        req.on('end', function () {
          ctx.messages.push(ctx.inprogress);
          ctx.inprogress = '';
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.end(ctx.keepRunner ? 'thanks!' : 'kill');
          if (ctx.onMessage) {
            ctx.onMessage();
          }
        });
      } else if (req.url === '/ready') {
        grunt.log.writeln(chalk.green('Done.'));
        res.end('Okay.');
        clearTimeout(ctx.cleanupTimeout);
      }
    }).listen(ctx.port);

    grunt.log.writeln(chalk.green('Done.'));
  }
  
  grunt.registerMultiTask('jasmine_firefoxaddon', pkg.description, function () {
    var ctx = this.options({
        template: __dirname + '/../tasks/jasmine-firefoxaddon',
        version: '2.0.0',
        outfile: '.build',
        paths: undefined,
        binary: undefined,
        keepRunner: false,
        port: 9979,
        timeout : 30000,
        flags: []
      });

    if (grunt.option('debug')) {
      grunt.log.debug(JSON.stringify(ctx));
    }

    ctx.files = this.files;
    if (!this.files) {
      grunt.log.error('No app target provided.');
      return false;
    }


    process.on('SIGINT', function () {
      cleanup(ctx);
    });
  
    grunt.config.set('jasmine_firefoxaddon_build', {
      ctx: ctx
    });
    grunt.config.set('jasmine_firefoxaddon_report', {
      ctx: ctx
    });

    if (!grunt.config.get('mozilla-addon-sdk')) {
      grunt.config.set('mozilla-addon-sdk', {
        '1_17': {
          options: {
            revision: "1.17"
          }
        },
        master: {
          options: {
            revision: "master",
            github: true
          }
        }
      });
    }

    grunt.task.run([
      'mozilla-addon-sdk:1_17',
      'jasmine_firefoxaddon_build',
      'mozilla-cfx:jasmine_firefoxaddon_test',
      'jasmine_firefoxaddon_report'
    ]);
  });


  grunt.registerMultiTask('jasmine_firefoxaddon_build', pkg.description, function () {
    var ctx = grunt.config.get('ctx');

    // Build Addon.
    buildSpec(ctx);

    // Create Listener.
    startReporter(ctx);

    // Configure downstream cfx run to use the generated addon.
    if (!grunt.config.get('mozilla-cfx')) {
      grunt.config.set('mozilla-cfx', {
        'jasmine_firefoxaddon_test': {
          options: {
            'mozilla-addon-sdk': "1_17",
            extension_dir: ctx.outfile,
            command: "run",
            'arguments': "-v"
          }
        }
      });
    }
    return true;
  });

  function finishTests(ctx) {
    var parse = JSON.parse(ctx.messages[0]),
      spec,
      i = 0;

    ctx.status = {failed: 0};
    for (i = 0; i < parse.length; i += 1) {
      spec = parse[i];
      if (process.stdout.clearLine) {
        process.stdout.clearLine();
        process.stdout.cursorTo(0);
        if (spec.status === 'passed') {
          grunt.log.writeln(chalk.green.bold('✓') + '\t' + spec.fullName);
        } else if (spec.status === 'failed') {
          ctx.status.failed += 1;
          grunt.log.writeln(chalk.red.bold('X') + '\t' + spec.fullName);
        } else {
          grunt.log.writeln(chalk.yellow.bold('*') + '\t' + spec.fullName);
        }
      } else {
        if (spec.status === 'passed') {
          grunt.log.writeln('✓' + spec.fullName);
        } else if (spec.status === 'failed') {
          ctx.status.failed += 1;
          grunt.log.writeln('X' + spec.fullName);
        } else {
          grunt.log.writeln('*' + spec.fullName);
        }
      }
    }
  }

  grunt.registerTask('jasmine_firefoxaddon_report', pkg.description, function () {
    var ctx = grunt.config.get('ctx');
    finishTests(ctx);

    return cleanup(ctx);
  });
};
