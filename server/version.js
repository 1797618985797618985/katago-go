'use strict';

const pkg = require('../package.json');

/** 全项目唯一的版本号来源：package.json 的 version。 */
const VERSION = pkg.version;
const APP_NAME = pkg.name || 'katago-go';

module.exports = { VERSION, APP_NAME };
