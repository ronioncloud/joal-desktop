/* eslint-disable no-underscore-dangle */
import fs from 'fs';
import events from 'events';
import path from 'path';
import request from 'request';
import zlib from 'zlib'; // FIXME: apparament zlib est intégré a NodeJs, donc on peut peut être enlever la dep du package.json
import tar from 'tar-fs';
import { app } from 'electron';
import mkdir from '../../utils/mkdir';
import rmdir from '../../utils/rmdir';
import cp from '../../utils/cp';
import {
  JOAL_IS_INSTALLED,
  JOAL_WILL_DOWNLOAD,
  JOAL_START_DOWNLOAD,
  JOAL_DOWNLOAD_HAS_PROGRESSED,
  JOAL_INSTALL_FAILED
} from './joalInstallerEvents';


export default class JoalUpdater extends events.EventEmitter {
  constructor() {
    super();

    const self = this;
    self.joalDir = path.join(app.getPath('userData'), 'joal-core');
    self.tempUpdateDir = path.join(self.joalDir, 'update-tmp');
    self.clientFilesDir = path.join(self.joalDir, 'clients');
    self.torrentsDir = path.join(self.joalDir, 'torrents');
    self.archivedTorrentsDir = path.join(self.torrentsDir, 'archived');
    self.joalCoreVersionFile = path.join(self.joalDir, '.joal-core');
    self.joalCoreVersion = '1.0.3';
    self.downloadUrl = `https://github.com/anthonyraymond/joal/releases/download/${self.joalCoreVersion}/test-do-not-download.tar.gz`;
  }

  _isLocalInstalled() {
    const self = this;

    // check for jar
    if (!fs.existsSync(self.joalDir)) return false;
    const isJarPresent = fs.readdirSync(self.joalDir).filter(fileName =>
      fileName.endsWith('.jar')
    ).length > 0;
    if (!isJarPresent) return false;

    // check for client files
    if (!fs.existsSync(self.clientFilesDir)) return false;
    const areClientFilesPresents = fs.readdirSync(self.clientFilesDir).filter(fileName =>
      fileName.endsWith('.client')
    ).length > 0;
    if (!areClientFilesPresents) return false;

    // check for torrents folder
    if (!fs.existsSync(self.torrentsDir)) return false;

    // check config.json
    if (!fs.existsSync(path.join(self.joalDir, 'config.json'))) return false;

    // check if the version file is present, and it the version matches
    if (!fs.existsSync(self.joalCoreVersionFile)) return false;
    if (fs.readFileSync(self.joalCoreVersionFile, { encoding: 'utf8' }) !== self.joalCoreVersion) return false;

    return true;
  }

  _cleanJoalFolder() {
    // Remvoe everything but 'config.json' and 'torrents' folder
    const self = this;

    const jarFilesPromises = [];
    if (fs.existsSync(self.joalDir)) {
      fs.readdirSync(self.joalDir) // delete all .jar
        .filter(fileName => fileName.endsWith('.jar'))
        .map(jar => rmdir(path.join(self.joalDir, jar)))
        .forEach(promise => jarFilesPromises.push(promise));
    }

    return Promise.all([
      rmdir(self.tempUpdateDir),
      rmdir(self.clientFilesDir),
      rmdir(self.joalCoreVersionFile),
      ...jarFilesPromises
    ]);
  }

  async installIfNeeded() {
    const self = this;

    if (self._isLocalInstalled()) {
      self.emit(JOAL_IS_INSTALLED);
      return;
    }

    self.emit(JOAL_WILL_DOWNLOAD);

    const oldJsonConfigFile = path.join(self.joalDir, 'config.json');
    const newJsonConfigFile = path.join(self.tempUpdateDir, 'config.json');

    try {
      await self._cleanJoalFolder();
    } catch (err) {
      self.emit(JOAL_INSTALL_FAILED, `An error occured while cleaning JOAL folder before install: ${err}`);
      return;
    }
    request.get({
      url: self.downloadUrl,
      rejectUnauthorized: false,
      agent: false,
      headers: {
        'User-Agent': 'Joal Desktop', // We pull GitHub, let's be nice and tell who we are.
        connection: 'keep-alive'
      }
    })
    .on('response', res => {
      // TODO: Si on tombe sur un 404, on arrive ici?
      const len = parseInt(res.headers['content-length'], 10);
      self.emit(JOAL_START_DOWNLOAD, len);

      const hundredthOfLength = Math.floor(len / 100);
      let chunkDownloadedSinceLastEmit = 0;
      res.on('data', chunk => {
        chunkDownloadedSinceLastEmit += chunk.length;
        // We will report at top 100 events per download
        if (chunkDownloadedSinceLastEmit >= hundredthOfLength) {
          const downloadedBytes = chunkDownloadedSinceLastEmit;
          chunkDownloadedSinceLastEmit = 0;
          self.emit(JOAL_DOWNLOAD_HAS_PROGRESSED, downloadedBytes);
        }
      });
    })
    .on('error', err => {
      self.emit(JOAL_INSTALL_FAILED, `Failed to download archive: ${err}`);
      self._cleanJoalFolder();
    })
    .pipe(zlib.createUnzip())
    .pipe(tar.extract(self.tempUpdateDir))
    .on('finish', () => { // FIXME: does 'end' set a param? maybe an error message on fail.
      // delete the old clients folder
      cp(path.join(self.tempUpdateDir, 'clients'), self.clientFilesDir)
      .then(() => {
        // get previous config.json (if exists)
        let oldConfig = {};
        if (fs.existsSync(oldJsonConfigFile)) {
          try {
            oldConfig = JSON.parse(fs.readFileSync(oldJsonConfigFile, { encoding: 'utf8' }));
          } catch (err) {} // eslint-disable-line no-empty
        }
        // get new config.json
        let newConfig;
        if (!fs.existsSync(newJsonConfigFile)) throw new Error(`File not found: ${newJsonConfigFile}`);
        try {
          newConfig = JSON.parse(fs.readFileSync(newJsonConfigFile, { encoding: 'utf8' }));
        } catch (err) {
          throw new Error(`Failed to parse new config.json: ${err}`);
        }

        // merge the two config (with old overriding new)
        const mergedConfig = Object.assign({}, newConfig, oldConfig);
        fs.writeFileSync(oldJsonConfigFile, JSON.stringify(mergedConfig, null, 2));
        return Promise.resolve();
      })
      .then(() => (
        // copy /update-tmp/.jar to /.jar
        Promise.all(fs.readdirSync(self.tempUpdateDir)
          .filter(fileName => fileName.endsWith('.jar'))
          .map(jar => cp(path.join(self.tempUpdateDir, jar), path.join(self.joalDir, jar)))
        )
      ))
      .then(() => (
        // remove temporary update folder
        rmdir(self.tempUpdateDir)
      ))
      .then(() => {
        // create torrent folder
        if (!fs.existsSync(self.torrentsDir)) return mkdir(self.torrentsDir);
        return Promise.resolve();
      })
      .then(() => {
        if (!fs.existsSync(self.archivedTorrentsDir)) return mkdir(self.archivedTorrentsDir);
        return Promise.resolve();
      })
      .then(() => {
        // write version file
        fs.writeFileSync(self.joalCoreVersionFile, self.joalCoreVersion);
        return Promise.resolve();
      })
      .then(() => {
        if (self._isLocalInstalled()) {
          self.emit(JOAL_IS_INSTALLED);
          return Promise.resolve();
        } else { // eslint-disable-line no-else-return
          throw new Error('Failed to validate joal deployement.');
        }
      })
      .catch((err) => {
        self.emit(JOAL_INSTALL_FAILED, `An error occured while deploying JOAL: ${err}`);
        self._cleanJoalFolder();
      });
    });
  }

}
