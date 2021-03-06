const jsondiffpatch = require('jsondiffpatch'),
  config = require('config'),
  Ajv = require('ajv'),
  fetch = require('node-fetch'),
  {UserError} = require('graphql-errors'),
  _ = require('lodash');

const {db, logger, fetchDS, assertUserCanEditDataset,
    addProcessingConfig, fetchMolecularDatabases} = require('./utils.js'),
  metadataSchema = require('./metadata_schema.json');

let {molecularDatabases} = 1;

ajv = new Ajv({allErrors: true});
validator = ajv.compile(metadataSchema);

function isEmpty(obj) {
  if (!obj)
    return true;
  if (!(obj instanceof Object))
    return false;
  let empty = true;
  for (var key in obj) {
    if (!isEmpty(obj[key])) {
      empty = false;
      break;
    }
  }
  return empty;
}

function trimEmptyFields(schema, value) {
  if (!(value instanceof Object))
    return value;
  if (Array.isArray(value))
    return value;
  let obj = Object.assign({}, value);
  for (var name in schema.properties) {
    const prop = schema.properties[name];
    if (isEmpty(obj[name]) && (!schema.required || schema.required.indexOf(name) == -1))
      delete obj[name];
    else
      obj[name] = trimEmptyFields(prop, obj[name]);
  }
  return obj;
}

function setSubmitter(oldMetadata, newMetadata, user) {
  const email = oldMetadata != null
    ? oldMetadata.Submitted_By.Submitter.Email
    : user.email;
  _.set(newMetadata, ['Submitted_By', 'Submitter', 'Email'], email)
}

function validateMetadata(metadata) {
  const cleanValue = trimEmptyFields(metadataSchema, metadata);
  validator(cleanValue);
  const validationErrors = validator.errors || [];
  if (validationErrors.length > 0) {
    throw new UserError(JSON.stringify({
      'type': 'failed_validation',
      'validation_errors': validationErrors
    }));
  }
}

async function molDBsExist(molDBNames) {
  const existingMolDBs = await fetchMolecularDatabases({hideDeprecated: false}),
    existingMolDBNames = new Set(existingMolDBs.map((mol_db) => mol_db.name));
  for (let name of molDBNames) {
    if (!existingMolDBNames.has(name))
      throw new UserError(JSON.stringify({
        'type': 'wrong_moldb_name',
        'moldb_name': name
      }));
  }
}

function reprocessingNeeded(ds, updDS) {
  const configDelta = jsondiffpatch.diff(ds.config, updDS.config),
    configDiff = jsondiffpatch.formatters.jsonpatch.format(configDelta),
    metaDelta = jsondiffpatch.diff(ds.metadata, updDS.metadata),
    metaDiff = jsondiffpatch.formatters.jsonpatch.format(metaDelta);

  let dbUpd = false, procSettingsUpd = false;
  for (let diffObj of configDiff) {
    if (diffObj.op !== 'move') {
      if (diffObj.path.startsWith('/databases'))
        dbUpd = true;
      else
        procSettingsUpd = true;
    }
  }

  if (procSettingsUpd) {
    throw new UserError(JSON.stringify({
      'type': 'drop_submit_needed',
      'hint': `Resubmission needed. Call 'submitDataset' with 'delFirst: true'.`,
      'metadata_diff': metaDiff,
      'config_diff': configDiff
    }))
  }
  else if (dbUpd) {
    throw new UserError(JSON.stringify({
      'type': 'submit_needed',
      'hint': `Resubmission needed. Call 'submitDataset'.`,
      'metadata_diff': metaDiff,
      'config_diff': configDiff
    }))
  }
}

async function smAPIRequest(datasetId, uri, body) {
  const url = `http://${config.services.sm_engine_api_host}${uri}`;
  let resp = await fetch(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json'
    }
  });

  const respText = await resp.text();
  if (!resp.ok) {
    throw new UserError(`smAPIRequest: ${respText}`);
  }
  else {
    logger.info(`Successful ${uri}: ${datasetId}`);
    logger.debug(`Body: ${JSON.stringify(body)}`);
    return respText;
  }
}

function updateObject(obj, upd) {
  const updObj = _.cloneDeep(obj);
  _.extend(updObj, upd);
  return updObj;
}

module.exports = {
  reprocessingNeeded,
  Query: {
    reprocessingNeeded: async (args, user) => {
      const {input} = args;
      const ds = await fetchDS({id: input.id});
      await assertUserCanEditDataset(ds.id, user);

      if (input.metadataJson !== undefined)
        input.metadata = JSON.parse(input.metadataJson);
      validateMetadata(input.metadata);

      const updDS = updateObject(ds, input);
      addProcessingConfig(updDS);

      try {
        await reprocessingNeeded(ds, updDS);
        return false;
      }
      catch (e) {
        return true;
      }
    }
  },
  Mutation: {
    submit: async (args, user) => {
      const {input: ds, priority, delFirst} = args;
      try {
        if (ds.id !== undefined) {
          await assertUserCanEditDataset(ds.id, user);
        }

        ds.metadata = JSON.parse(ds.metadataJson);
        setSubmitter(null, ds.metadata, user);
        validateMetadata(ds.metadata);
        await molDBsExist(ds.molDBs);
        addProcessingConfig(ds);

        const body = {
          name: ds.name,
          input_path: ds.inputPath,
          upload_dt: ds.uploadDT,
          metadata: ds.metadata,
          config: ds.config,
          priority: priority,
          del_first: delFirst,
          is_public: ds.isPublic,
          mol_dbs: ds.molDBs,
          adducts: ds.adducts
        };
        if (ds.id !== undefined)
          body.id = ds.id;
        return await smAPIRequest(ds.id, '/v1/datasets/add', body);
      } catch (e) {
        logger.error(e.stack);
        throw e;
      }
    },
    update: async (args, user) => {
      const {input, priority} = args;
      try {
        let ds = await fetchDS({id: input.id});
        if (ds === undefined) {
          throw new UserError('DS does not exist');
        }
        await assertUserCanEditDataset(ds.id, user);

        if (input.metadataJson !== undefined)
          input.metadata = JSON.parse(input.metadataJson);
        const updDS = updateObject(ds, input);

        setSubmitter(ds.metadata, updDS.metadata, user);
        validateMetadata(updDS.metadata);
        addProcessingConfig(updDS);
        await reprocessingNeeded(ds, updDS);

        const body = {
          metadata: updDS.metadata,
          config: updDS.config,
          name: updDS.name,
          upload_dt: updDS.uploadDT,
          priority: priority,
          is_public: updDS.isPublic
        };
        return await smAPIRequest(updDS.id, `/v1/datasets/${updDS.id}/update`, body);
      } catch (e) {
        logger.error(e.stack);
        throw e;
      }
    },
    delete: async (args, user) => {
      const {datasetId} = args;

      try {
        await assertUserCanEditDataset(datasetId, user);

        try {
          await smAPIRequest(datasetId, `/v1/datasets/${datasetId}/del-optical-image`, {});
        }
        catch (err) {
          logger.warn(err);
        }

        return await smAPIRequest(datasetId, `/v1/datasets/${datasetId}/delete`, {});
      } catch (e) {
        logger.error(e.stack);
        throw e;
      }
    },
    addOpticalImage: async (args, user) => {
      let {datasetId, imageUrl, transform} = args;
      const basePath = `http://localhost:${config.img_storage_port}`;
      if (imageUrl[0] === '/') {
        // imageUrl comes from the web application and should not include host/port.
        //
        // This is necessary for a Virtualbox installation because of port mapping,
        // and preferred for AWS installation because we're not charged for downloads
        // if internal network is used.
        //
        // TODO support image storage running on a separate host
        imageUrl = basePath + imageUrl;
      }
      try {
        logger.info(args);
        await assertUserCanEditDataset(datasetId, user);
        const uri = `/v1/datasets/${datasetId}/add-optical-image`;
        const body = {url: imageUrl, transform};
        return await smAPIRequest(datasetId, uri, body);
      } catch (e) {
        logger.error(e.message);
        throw e;
      }
    },
    deleteOpticalImage: async (args, user) => {
      const {datasetId} = args;
      await assertUserCanEditDataset(datasetId, user);
      return await smAPIRequest(datasetId, `/v1/datasets/${datasetId}/del-optical-image`, {});
    }
  }
};
