#!/usr/bin/env node

process.env.AURA_CLI_FLAVOR = process.env.AURA_CLI_FLAVOR || 'aurawallet';
require('./auramaxx.js');
