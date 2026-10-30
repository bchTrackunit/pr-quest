const { defineConfig } = require('eslint/config');
const { configs } = require('@trackunit/eslint-plugin-trackunit');
const baseConfig = require('../../eslint.config.cjs');

module.exports = defineConfig([...baseConfig, ...configs.react]);
