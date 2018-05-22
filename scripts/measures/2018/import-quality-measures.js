const parse = require('csv-parse/lib/sync');
const _ = require('lodash');
const fs = require('fs');
const path = require('path');

const Constants = require('../../../constants.js');
/**
 * `import-quality-measures` reads a quality CSV file and creates valid measures,
 * then writes the resulting json to a staging measures-data-quality.js file.
 */

/**
 * [config defines how to generate quality measures from origin CSV file]
 * @type {Object}
 *
 *  * `constant_fields` are fields which are the same for all measures being
 *  created from the CSV input.
 *  * `source_fields` are fields which should find values in the CSV input.
 *
 */
const CONFIG = {
  constant_fields: {
    category: 'quality',
    isRegistryMeasure: false,
    isRiskAdjusted: false
  },
  sourced_fields: {
    // fields are csv columns indexed starting from 1 (the provided
    // spreadsheet has a leftmost blank column)
    title: 1,
    eMeasureId: 2,
    nqfEMeasureId: 3,
    nqfId: 4,
    measureId: 5,
    description: 6,
    nationalQualityStrategyDomain: 7,
    measureType: {
      index: 8,
      mappings: { // there should be no capital letters in the keys below
        'process': 'process',
        'outcome': 'outcome',
        'patient engagement/experience': 'patientEngagementExperience',
        'efficiency': 'efficiency',
        'intermediate outcome': 'intermediateOutcome',
        'structure': 'structure',
        'patient reported outcome': 'outcome',
        'composite': 'outcome',
        'cost/resource use': 'efficiency',
        'clinical process effectiveness': 'process'
      }
    },
    primarySteward: 9,
    metricType: 51,
    firstPerformanceYear: {
      index: 52,
      default: 2017
    },
    lastPerformanceYear: {
      index: 53,
      default: null
    },
    isHighPriority: {
      index: 55,
      default: false
    },
    isInverse: {
      index: 56,
      default: false
    },
    overallAlgorithm: 60
  }
};

// mapping from quality measures csv column numbers to submission method
const SUBMISSION_METHODS = {
  10: 'claims',
  11: 'certifiedSurveyVendor',
  12: 'electronicHealthRecord',
  13: 'cmsWebInterface',
  14: 'administrativeClaims',
  15: 'registry'
};

// mapping from quality measures csv column numbers to measure sets
const MEASURE_SETS = {
  16: 'allergyImmunology',
  17: 'anesthesiology',
  18: 'cardiology',
  19: 'dermatology',
  20: 'diagnosticRadiology',
  21: 'electrophysiologyCardiacSpecialist',
  22: 'emergencyMedicine',
  23: 'gastroenterology',
  24: 'generalOncology',
  25: 'generalPracticeFamilyMedicine',
  26: 'generalSurgery',
  27: 'hospitalists',
  28: 'internalMedicine',
  29: 'interventionalRadiology',
  30: 'mentalBehavioralHealth',
  31: 'neurology',
  32: 'obstetricsGynecology',
  33: 'ophthalmology',
  34: 'orthopedicSurgery',
  35: 'otolaryngology',
  36: 'pathology',
  37: 'pediatrics',
  38: 'physicalMedicine',
  39: 'plasticSurgery',
  40: 'preventiveMedicine',
  41: 'radiationOncology',
  42: 'rheumatology',
  43: 'thoracicSurgery',
  44: 'urology',
  45: 'vascularSurgery'
};

function getCsv(csvPath, headerRows = 1) {
  const csv = fs.readFileSync(path.join(__dirname, csvPath), 'utf8');
  const parsedCsv = parse(csv, 'utf8');

  // remove header rows
  for (let i = 0; i < headerRows; i++) {
    parsedCsv.shift();
  }

  return parsedCsv;
}

// Accounts for TRUE, True, true, X, x...
// and people sometimes insert extra spaces
function cleanInput(input) {
  return input.trim().toLowerCase();
}

// map specific csv input values to their representation in the measures schema
function mapInput(input) {
  const cleanedInput = cleanInput(input);
  if (cleanedInput === 'true' || cleanedInput === 'x') {
    return true;
  } else if (cleanedInput === 'false') {
    return false;
  } else if (cleanedInput === 'null' || cleanedInput === 'n/a') {
    return null;
  } else if (Constants.validPerformanceYears.includes(Number(cleanedInput))) {
    return Number(cleanedInput);
  } else {
    // if csv input isn't one of the special cases above, just return it
    return input.trim();
  }
}

// used when multiple csv columns map into a single measure field
function getCheckedColumns(row, columnNumberToNameMap) {
  const checkedColumns = [];

  _.each(columnNumberToNameMap, (value, key) => {
    if (mapInput(row[key]) === true) {
      checkedColumns.push(value);
    }
  });

  return checkedColumns;
}

// loop through all the strata in the strata csv and add them to the measure object
// (there exist multiple csv rows of strata for each multiPerformanceRate measure)
const addMultiPerformanceRateStrata = function(measures, strataRows) {
  _.each(strataRows, row => {
    if (!row[0]) {
      return; // csv has a blank row, so skip it
    }

    const measureId = row[0].trim();
    const stratumName = row[1].trim();
    const description = row[3].trim();

    const measure = _.find(measures, {'measureId': measureId});
    if (!measure) {
      throw TypeError('Measure id: ' + measureId + ' does not exist in ' +
        qualityMeasuresPath + ' but does exist in ' + qualityStrataPath);
    }

    if (!measure.strata) {
      measure.strata = [];
    }

    measure.strata.push({
      name: stratumName,
      description: description
    });
  });

  return measures;
};

/**
 * [convertCsvToMeasures description]
 * @param  {array of arrays}  records each array in the outer array represents a new measure, each inner array its attributes
 * @param  {object}           config  object defining how to build a new measure from this csv file, including mapping of measure fields to column indices
 * @return {array}            Returns an array of measures objects
 *
 * Notes:
 * 1. The terms [performance rate] 'strata' and 'performance rates' are used interchangeably
 * 2. We trim all data sourced from CSVs because people sometimes unintentionally include spaces or linebreaks
 */
const convertQualityStrataCsvsToMeasures = function(qualityCsvRows, strataCsvRows) {
  const sourcedFields = CONFIG.sourced_fields;
  const constantFields = CONFIG.constant_fields;

  const measures = qualityCsvRows.map(function(row) {
    const measure = {};
    Object.entries(sourcedFields).forEach(function([measureKey, columnObject]) {
      if (typeof columnObject === 'number') {
        const input = row[columnObject];
        if (_.isUndefined(input)) {
          throw Error('Column ' + columnObject + ' does not exist in source data');
        } else if (input !== '') {
          measure[measureKey] = mapInput(input);
        }
      } else {
        let value;
        if (columnObject.mappings) {
          const input = cleanInput(row[columnObject.index]);
          value = columnObject.mappings[input];
        } else {
          value = mapInput(row[columnObject.index]);
        }

        measure[measureKey] = value || columnObject['default'];
      }
    });

    Object.entries(constantFields).forEach(function([measureKey, measureValue]) {
      measure[measureKey] = measureValue;
    });

    measure['submissionMethods'] = getCheckedColumns(row, SUBMISSION_METHODS);
    measure['measureSets'] = getCheckedColumns(row, MEASURE_SETS);

    return measure;
  });

  return addMultiPerformanceRateStrata(measures, strataCsvRows);
};

function importQualityMeasures() {
  const qualityCsv = getCsv(qualityMeasuresPath, 2);
  const strataCsv = getCsv(qualityStrataPath, 2);

  const qualityMeasures = convertQualityStrataCsvsToMeasures(qualityCsv, strataCsv);
  const qualityMeasuresJson = JSON.stringify(qualityMeasures, null, 2);

  fs.writeFileSync(path.join(__dirname, outputPath), qualityMeasuresJson);
}

const qualityMeasuresPath = process.argv[2];
const qualityStrataPath = process.argv[3];
const outputPath = process.argv[4];

importQualityMeasures();