/**
 * Created by intsco on 1/11/17.
 */

const sprintf = require('sprintf-js'),
  fetch = require('node-fetch'),
  jsondiffpatch = require('jsondiffpatch'),
  jwt = require('jwt-simple'),
  slack = require('node-slack');

const smEngineConfig = require('./sm_config.json'),
  {esSearchResults, esCountResults} = require('./esConnector'),
  {datasetFilters, dsField, SubstringMatchFilter} = require('./datasetFilters.js'),
  config = require('./config');


const dbConfig = () => {
  const {host, database, user, password} = smEngineConfig.db;
  return {
    host, database, user, password,
    max: 10, // client pool size
    idleTimeoutMillis: 30000
  };
};

let pg = require('knex')({
  client: 'pg',
  connection: dbConfig(),
  searchPath: 'knex,public'
});

const slackConn = new slack(smEngineConfig.slack.webhook_url);

const Resolvers = {
  Person: {
    name(obj) { return obj.First_Name; },
    surname(obj) { return obj.Surname; },
    email(obj) { return obj.Email; }
  },

  Query: {
    datasetByName(_, { name }) {
      return pg.select().from('dataset').where('name', '=', name)
        .then((data) => {
          return data.length > 0 ? data[0] : null;
        })
        .catch((err) => {
          console.log(err); return null;
        });
    },

    dataset(_, { id }) {
      return pg.select().from('dataset').where('id', '=', id)
        .then((data) => {
          return data.length > 0 ? data[0] : null;
        })
        .catch((err) => {
          console.log(err); return null;
        });
    },

    allDatasets(_, {orderBy, sortingOrder, offset, limit, filter}) {
      let q = pg.select().from('dataset');

      console.log(JSON.stringify(filter));

      if (filter.name)
        q = q.where("name", "=", filter.name);

      for (var key in datasetFilters) {
        const val = filter[key];
        if (val)
          q = datasetFilters[key].pgFilter(q, val);
      }

      const orderVar = orderBy == 'ORDER_BY_NAME' ? 'name' : 'id';
      const ord = sortingOrder == 'ASCENDING' ? 'asc' : 'desc';

      console.log(q.toString());

      return q.orderBy(orderVar, ord).offset(offset).limit(limit)
        .catch((err) => { console.log(err); return []; });
    },

    allAnnotations(_, args) {
      return esSearchResults(args);
    },

    countAnnotations(_, args) {
      return esCountResults(args);
    },

    annotation(_, { id }) {
      return es.get({index: esIndex, type: 'annotation', id})
        .then((resp) => {
          return resp;
        }).catch((err) => {
          return null;
        });
    },

    metadataSuggestions(_, { field, query }) {
      let f = new SubstringMatchFilter(field, {}),
          q = pg.distinct(pg.raw(f.pgField + " as field")).select().from('dataset');
      return f.pgFilter(q, query).then(results => results.map(row => row['field']));
    }
  },

  Analyzer: {
    resolvingPower(msInfo, { mz }) {
      const rpMz = msInfo.rp.mz,
        rpRp = msInfo.rp.Resolving_Power;
      if (msInfo.type.toUpperCase() == 'ORBITRAP')
        return Math.sqrt(rpMz / mz) * rpRp;
      else if (msInfo.type.toUpperCase() == 'FTICR')
        return (rpMz / mz) * rpRp;
      else
        return rpRp;
    }
  },

  Dataset: {
    metadataJson(ds) {
      return JSON.stringify(ds.metadata);
    },

    institution(ds) { return dsField(ds, 'institution'); },
    organism(ds) { return dsField(ds, 'organism'); },
    polarity(ds) { return dsField(ds, 'polarity').toUpperCase(); },
    ionisationSource(ds) { return dsField(ds, 'ionisationSource'); },
    maldiMatrix(ds) { return dsField(ds, 'maldiMatrix'); },

    submitter(ds) {
      return ds.metadata.Submitted_By.Submitter;
    },

    principalInvestigator(ds) {
      return ds.metadata.Submitted_By.Principal_Investigator;
    },

    analyzer(ds) {
      const msInfo = ds.metadata.MS_Analysis;
      return {
        'type': msInfo.Analyzer,
        'rp': msInfo.Detector_Resolving_Power
      };
    },

    /* annotations(ds, args) {
     args.datasetId = ds.id;
     return esSearchResults(args);
     } */
  },

  Annotation: {
    id(hit) {
      return hit._id;
    },

    sumFormula(hit) {
      return hit._source.sf;
    },

    possibleCompounds(hit) {
      const ids = hit._source.comp_ids.split('|');
      const names = hit._source.comp_names.split('|');
      let compounds = [];
      for (var i = 0; i < names.length; i++) {
        let id = ids[i];
        let infoURL;
        if (hit._source.db_name == 'HMDB') {
          id = sprintf.sprintf("HMDB%05d", id);
          infoURL = `http://www.hmdb.ca/metabolites/${id}`;
        } else if (hit._source.db_name == 'ChEBI') {
          id = "CHEBI:" + id;
          infoURL = `http://www.ebi.ac.uk/chebi/searchId.do?chebiId=${id}`;
        } else if (hit._source.db_name == 'SwissLipids') {
          id = sprintf.sprintf("SLM:%09d", id);
          infoURL = `http://swisslipids.org/#/entity/${id}`;
        } else if (hit._source.db_name == 'LIPID_MAPS') {
          infoURL = `http://www.lipidmaps.org/data/LMSDRecord.php?LMID=${id}`;
        }

        compounds.push({
          name: names[i],
          imageURL: `http://${config.MOL_IMAGE_SERVER_IP}/mol-images/${hit._source.db_name}/${id}.svg`,
          information: [{database: hit._source.db_name, url: infoURL}]
        });
      }
      return compounds;
    },

    adduct: (hit) => hit._source.adduct,

    mz: (hit) => parseFloat(hit._source.mz),

    fdrLevel: (hit) => hit._source.fdr,

    msmScore: (hit) => hit._source.msm,

    rhoSpatial: (hit) => hit._source.image_corr,

    rhoSpectral: (hit) => hit._source.pattern_match,

    rhoChaos: (hit) => hit._source.chaos,

    dataset(hit) {
      return {
        id: hit._source.ds_id,
        name: hit._source.ds_name,
        metadata: hit._source.ds_meta
      }
    },

    ionImage(hit) {
      return {
        url: hit._source.ion_image_url
      };
    },

    peakChartData(hit) {
      const {sf_adduct, ds_meta} = hit._source;
      const msInfo = ds_meta.MS_Analysis;
      const host = config.MOLDB_SERVICE_HOST,
        instr = msInfo.Analyzer.toLowerCase(),
        rp = msInfo.Detector_Resolving_Power.Resolving_Power,
        at_mz = msInfo.Detector_Resolving_Power.mz,
        pol = msInfo.Polarity.toLowerCase() == 'positive' ? '+1' : '-1';

      const url = `http://${host}/v1/isotopic_pattern/${sf_adduct}/${instr}/${rp}/${at_mz}/${pol}`;
      return fetch(url).then(res => res.json()).then(json => JSON.stringify(json));
    },

    isotopeImages(hit) {
      const {iso_image_urls, centroid_mzs} = hit._source;
      return iso_image_urls.map((url, i) => ({
        url,
        mz: parseFloat(centroid_mzs[i])
      }));
    }
  },

  Mutation: {
    submitDataset(_, args) {
      const {path, metadataJson} = args;
      try {
        const metadata = JSON.parse(metadataJson);
      
        const message = {
          ds_name: metadata.metaspace_options.Dataset_Name,
          ds_id: moment().format("Y-MM-DD_HH[h]mm[m]ss[s]"),
          input_path: path,
          user_email: metadata.Submitted_By.Submitter.Email
        };
      
        copyMetadata(path, metadataJson).then(() => {
          sendMessageToRabbitMQ(JSON.stringify(message));
        });
      
        return "success";
      } catch (e) {
        return e.message;
      }
    },
    
    updateMetadata(_, args) {
      const {datasetId, metadataJson} = args;
      try {
        const newMetadata = JSON.parse(metadataJson);
        const payload = jwt.decode(args.jwt, smEngineConfig.jwt.secret);

        return pg.select().from('dataset').where('id', '=', datasetId)
          .then(records => {
            const oldMetadata = records[0].metadata,
                  datasetName = records[0].name;

            // check if the user has permissions to modify the metadata
            let allowUpdate = false;
            if (payload.role == 'admin')
              allowUpdate = true;
            else if (payload.email == oldMetadata.Submitted_By.Submitter.Email)
              allowUpdate = true;
            if (!allowUpdate)
              throw new Error("you don't have permissions to edit this dataset");

            // update the database record
            // FIXME: the rest of updateMetadata function should move into the dataset service
            return pg('dataset').where('id', '=', datasetId).update({
              metadata: metadataJson,
              name: newMetadata.metaspace_options.Dataset_Name
            }).then(_ => ({oldMetadata, oldDatasetName: datasetName}))
          })
          .then(({oldMetadata, oldDatasetName}) => {
            // compute delta between old and new metadata
            const delta = jsondiffpatch.diff(oldMetadata, newMetadata),
                  diff = jsondiffpatch.formatters.jsonpatch.format(delta);

            // run elasticsearch reindexing in the background mode
            if (diff.length > 0) {
              fetch(`http://${config.ES_API}/reindex/${datasetId}`, { method: 'POST'})
                .then(resp => console.log(`reindexed ${datasetId}`))
                .catch(err => console.log(err));
            }

            // determined if reprocessing is needed
            const changedPaths = diff.map(item => item.path);
            let needsReprocessing = false;
            for (let path of changedPaths) {
              if (path.startsWith('/MS_Analysis') && path != '/MS_Analysis/Ionisation_Source')
                needsReprocessing = true;
              if (path == '/metaspace_options/Metabolite_Database')
                needsReprocessing = true;
            }

            // send a Slack notification about the change
            let msg = slackConn.send({
              text: `${payload.name} edited metadata of ${oldDatasetName} (id: ${datasetId})` +
                "\nDifferences:\n" + JSON.stringify(diff, null, 2),
              channel: smEngineConfig.slack.channel
            });

            if (needsReprocessing) {
              // TODO: send message straight to the RabbitMQ
              msg.then(() => { slackConn.send({
                text: `@vitaly please reprocess ^`, channel: smEngineConfig.slack.channel
              })});
            }
          })
          .then(() => "success");
      } catch (e) {
        return e.message;
      }
    }
  }
};

module.exports = Resolvers;
