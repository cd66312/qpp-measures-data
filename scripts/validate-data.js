/**
 * Expects JSON from standard input and validates against a specified version and
 * type of schema. If no version is specified, the schema version will default
 * to the latest. In the case of an invalid JSON document, the output will contain
 * the validation error.
 *
 * This script can be used as follows:
 * cat [json file path] | node [this file's path] [schemaType] [performanceYear]
 * Example:
 * cat measures/measures-data.json | node scripts/validate-data.js measures 2018
 **/

const Ajv = require('ajv');
const path = require('path');
const YAML = require('yamljs');

const Constants = require('../constants.js');

const ajv = new Ajv({ verbose: true });
require('ajv-keywords')(ajv, 'uniqueItemProperties');

const schemaType = process.argv[2];
const performanceYear = (process.argv[3] || Constants.currentPerformanceYear).toString();

let json = '';
function validate(json) {
  const valid = ajv.validate(
    YAML.load(path.join(__dirname, '../' + schemaType,
      performanceYear,
      schemaType + '-schema.yaml')),
    JSON.parse(json, 'utf8'));
  if (valid) {
    console.log('Valid for ' + performanceYear + ' performance year schema');
  } else {
    console.log('Invalid for ' + performanceYear + ' performance year schema: ' +
      ajv.errorsText(ajv.errors));
    console.log('Detailed error: ', ajv.errors);
  }
}

if (schemaType) {
  process.stdin.setEncoding('utf8');

  process.stdin.on('readable', function() {
    const chunk = this.read();
    if (chunk !== null) {
      json += chunk;
    }
  });

  process.stdin.on('end', function() {
    validate(json);
  });
} else {
  console.log('Please provide schema type, e.g. measures or benchmarks\nExample Command: cat ../measures/measures-data.json | node validate-data.js measures');
}
