/**
 * @overview Module for interacting with Artifactory REST API.
 */

var _ = require('underscore'),
  Q = require('q'),
  request = require('request'),
  path = require('path'),
  fs = require('fs'),
  md5File = require('md5-file');


/**
 * Creates a new Artifactory client instance
 * @constructs ArtifactoryClient
 * @param {String} url Base url of Artifactory instance (like 'http://localhost:8080/artifactory'). It should contain path if your instance uses it (by default)
 * @param {Object} [options]  Additinal options
 * @param {boolean} [options.strictSSL]
 */
function ArtifactoryClient(url, options) {
  this.url = url;
  this.options = _.extend({strictSSL: false}, options);
}


/**
 * @prop {object} ACTIONS - The ACTIONS listed here represent well-known paths for
 * common artifactory actions.
 * @static
 */
ArtifactoryClient.API = {
  encryptedPassword   : '/api/security/encryptedPassword',
  filePath      : '/<%= repoKey %>/<%= filePath %>',
  getFileInfo   : '/api/storage/<%= repoKey %>/<%= filePath %>',
  downloadFolder: '/api/archive/download/<%= repoKey %>/<%= path %>',
  moveIem       : '/api/move/<%= srcRepoKey %>/<%= srcFilePath %>?to=/<%= dstRepoKey %>/<%= dstFilePath %>',
  getNpmConfigGlobal  : '/api/npm/auth',
  getNpmConfigScoped  : '/api/npm/<%= repoKey %>/auth/<%= scope %>'
};


function toBase64 (str) {
  return (new Buffer(str || '', 'utf8')).toString('base64')
}

/**
 * Set auth for all subsequent requests.
 * @param {String} auth basic auth (user+password in base64 w/o "Basic ")
 * OR
 * @param {String} login User name
 * @param {String} password User password (plain or encrypted)
 */
ArtifactoryClient.prototype.setAuth = function () {  
  if (arguments.length === 2) {
    this.basicHttpAuth = toBase64(arguments[0] + ":" + arguments[1]);
  } else if (arguments.length === 1) {
    this.basicHttpAuth = arguments[0];
  }
}

/**
 * 
 */
ArtifactoryClient.prototype.getNpmConfig = function (login, password, repoKey, scope) {
  var deferred = Q.defer();
  var url = ArtifactoryClient.API.getNpmConfigGlobal;
  if (repoKey && scope) {
    url = ArtifactoryClient.API.getNpmConfigScoped;
  }
  var compiled = _.template(url);
  url = compiled({
    repoKey: repoKey,
    scope  : scope
  });
  var options = {
    url: this.url + url,
    strictSSL: false
  };
  if (login) {
    options.auth = {
		username: login,
		password: password
	};
  }
  request.get(options, function (error, response) {
    if (error) {
      deferred.reject(error.message);
      return;
    }
    if (response.statusCode === 200) {
      deferred.resolve(response.body);
    }

    if (response.body) {
      var result;
      try { result = JSON.parse(response.body); } catch(e) {}
    }
    if (response.statusCode === 401) {
      deferred.reject({statusCode: 401, status: "Unauthorized", result: result && result.errors ? result.errors[0] : result });
    }
    deferred.reject(response.statusCode);
  });

  return deferred.promise;
}

/** 
 * Get common request options for the specified url and optional querystring params.
 * @param {string} actionPath Action relative url 
 * @paran [object] params Optinal querystring params
 */
ArtifactoryClient.prototype.getRequestOptions = function (actionPath, params) {
  
  var options = {
    url: this.url + actionPath,
    headers: {},
    strictSSL: false,
    params: params,
  };
  if (this.basicHttpAuth) {
    options.headers['Authorization'] = 'Basic ' + this.basicHttpAuth
  }
  if (params) {
    options.qs = params;
  }
  return options;
}


/** 
 * Get user encrypted password.
 * See {@link https://www.jfrog.com/confluence/display/RTF/Artifactory+REST+API#ArtifactoryRESTAPI-GetUserEncryptedPassword|Get User Encrypted Password}.
 * @param   {string} login Login name of a Artifactory user
 * @param   {string} password User password to encrypt
 * @returns {object} A QPromise to a encrypted password
 */
ArtifactoryClient.prototype.getEncryptedPassword = function (login, password) {
  var deferred = Q.defer();
  var url = ArtifactoryClient.API.encryptedPassword;
  var options = {
    url: this.url + url,
	auth: {
		username: login,
		password: password
	},
    strictSSL: false
  };
  request.get(options, function (error, response) {
    if (error) {
      deferred.reject(error.message);
      return;
    }
    if (response.statusCode !== 200) {
      deferred.reject(response.statusCode);
      return;
    }
    deferred.resolve(response.body);
  });

  return deferred.promise;
}


/** 
 * Get file/folder info from Artifactory.
 * @param   {string} repoKey  The key of the repo where the file is stored.
 * @param   {string} remotefilePath The path to the file/folder inside the repo.
 * @returns {object} A QPromise to a json object with the file's info as specified in the {@link http://www.jfrog.com/confluence/display/RTF/Artifactory+REST+API#ArtifactoryRESTAPI-FileInfo|FileInfo} Artifactory API.
 */
ArtifactoryClient.prototype.getFileInfo = function (repoKey, remotefilePath) {
  var deferred = Q.defer();
  var compiled = _.template(ArtifactoryClient.API.getFileInfo);
  var actionPath = compiled({
    repoKey: repoKey,
    filePath: remotefilePath
  });

  request.get(this.getRequestOptions(actionPath), function (error, response) {
    if (error) {
      deferred.reject(error.message);
      return;
    }
    //We expect an OK return code.
    if (response.statusCode !== 200) {
      deferred.reject(response.statusCode);
      return;
    }
    deferred.resolve(JSON.parse(response.body));
  });

  return deferred.promise;
};

/** 
 * Get folder info from Artifactory.
 * @param   {string} repoKey  The key of the repo where the file is stored.
 * @param   {string} remotePath The path to the folder inside the repo.
 * @returns {object} A QPromise to a json object with the folder's info as specified in the {@link http://www.jfrog.com/confluence/display/RTF/Artifactory+REST+API#ArtifactoryRESTAPI-FolderInfo|FolderInfo} Artifactory API.
 */
ArtifactoryClient.prototype.getFolderInfo = function (repoKey, remotePath) {
  if (remotePath[remotePath.length - 1] !== '/') {
    remotePath = remotePath + '/';
  }
  return this.getFileInfo(repoKey, remotePath);
}


/**
 * Checks if the file exists.
 * @param   {string} repoKey  The key of the repo.
 * @param   {string} remotefilePath The path to a file/folder inside the repo.
 * @returns {object} A QPromise to a boolean value
 */
ArtifactoryClient.prototype.isPathExists = function (repoKey, remotefilePath) {
  var deferred = Q.defer();
  var compiled = _.template(ArtifactoryClient.API.filePath);
  var actionPath = compiled({
    repoKey: repoKey,
    filePath: remotefilePath
  });

  request.head(this.getRequestOptions(actionPath), function (error, response) {
    switch (response.statusCode) {
    case 200:
      deferred.resolve(true);
      break;
    case 404:
      deferred.resolve(false);
      break;
    default:
      deferred.reject(response.statusCode);
      break;
    }
  });

  return deferred.promise;
};


/**
 * Uploads a file to artifactory. The uploading file needs to exist!
 * @param   {string} repoKey  The key of the repo where the file is stored.
 * @param   {string} remotefilePath The path to the file inside the repo. (in the server)
 * @param   {string} fileToUploadPath Absolute or relative path to the file to upload.
 * @param   {boolean} [forceUpload=false] Flag indicating if the file should be upload if it already exists.
 * @returns {object} A QPromise to a json object with creation info as specified in the {@link http://www.jfrog.com/confluence/display/RTF/Artifactory+REST+API#ArtifactoryRESTAPI-DeployArtifact|DeployArtifact} Artifactory API.
 */
ArtifactoryClient.prototype.uploadFile = function (repoKey, remotefilePath, fileToUploadPath, forceUpload) {
  var deferred = Q.defer(),
    overwriteFileInServer = forceUpload || false,
    isRemote = !!fileToUploadPath.match(/^https?:\/\//i),
    fileToUpload = isRemote ? fileToUploadPath : path.resolve(fileToUploadPath);

  /*
    Check the file to upload does exist! (if local)
  */
  if (!isRemote && !fs.existsSync(fileToUpload)) {
    deferred.reject('The file to upload ' + fileToUpload + ' does not exist');
    return deferred.promise;
  }

  /*
    Create everything for doing the request
  */
  var compiled = _.template(ArtifactoryClient.API.filePath);
  var actionPath = compiled({
    repoKey: repoKey,
    filePath: remotefilePath
  });

  //Check if file exists..
  this.isPathExists(repoKey, remotefilePath).then(function (fileExists) {
    if (fileExists && !overwriteFileInServer) {
      deferred.reject('File already exists and forceUpload flag was not provided with a TRUE value.');
      return;
    }

    var stream = isRemote ? request(fileToUpload) : fs.createReadStream(fileToUpload);
    //In any other case then proceed with *upload*
    stream.pipe(request.put(this.getRequestOptions(actionPath), function (error, response) {
      if (error) {
        deferred.reject(error.message);
        return;
      }
      //We expect a CREATED return code.
      if (response.statusCode !== 201) {
        deferred.reject('HTTP Status Code from server was: ' + response.statusCode);
        return;
      }
      deferred.resolve(JSON.parse(response.body));
    }));
  }).fail(function (err) {
    deferred.reject(err);
  });

  return deferred.promise;
};


/** 
 * Downloads an artifactory artifact to a specified file path. The folder where the file will be created MUST exist.
 * @param   {string} repoKey  The key of the repo where the file is stored.
 * @param   {string} remotefilePath The path to the file inside the repo. (in the server)
 * @param   {string} destinationFile Absolute or relative path to the destination file. The folder that will contain the destination file must exist.
 * @param   {boolean} [checkChecksum=false] A flag indicating if a checksum verification should be done as part of the download.
 * @returns {object} A QPromise to a string containing the result.
 */
ArtifactoryClient.prototype.downloadFile = function (repoKey, remotefilePath, destinationFile, checkChecksum) {
  var deferred = Q.defer(),
    checkFileIntegrity = checkChecksum || false,
    self = this,
    destinationPath = path.resolve(destinationFile);

  if (!fs.existsSync(path.dirname(destinationPath))) {
    deferred.reject('The destination folder ' + path.dirname(destinationPath) + ' does not exist.');
    return deferred.promise;
  }

  var compiled = _.template(ArtifactoryClient.API.filePath);
  var actionPath = compiled({
    repoKey: repoKey,
    filePath: remotefilePath
  });

  var req = request.get(this.getRequestOptions(actionPath));
  req.on('response', function (resp) {
    if (resp.statusCode === 200) {
      var stream = req.pipe(fs.createWriteStream(destinationPath));
      stream.on('finish', function () {
        if (checkFileIntegrity) {
          self.getFileInfo(repoKey, remotefilePath).then(function (fileInfo) {
            md5File(destinationPath, function (err, sum) {
              if (err) {
                deferred.reject('Error while calculating MD5: ' + err.toString());
                return;
              }
              if (sum === fileInfo.checksums.md5) {
                deferred.resolve('Download was SUCCESSFUL even checking expected checksum MD5 (' + fileInfo.checksums.md5 + ')');
              } else {
                deferred.reject('Error downloading file ' + options.url + '. Checksum (MD5) validation failed. Expected: ' +
                  fileInfo.checksums.md5 + ' - Actual downloaded: ' + sum);
              }
            });
          }).fail(function (err) {
            deferred.reject(err);
          });
        } else {
          deferred.resolve('Download was SUCCESSFUL');
        }
      });
    } else {
      deferred.reject('Server returned ' + resp.statusCode);
    }
  });

  return deferred.promise;
};


/** 
 * Downloads an artifactory folder as zip archive to a specified file path. The folder where the local file will be created MUST exist.
 * @param   {string} repoKey  The key of the repo.
 * @param   {string} remotePath The path to a folder inside the repo.
 * @param   {string} destinationFile Absolute or relative path to a local file. The folder that will contain the destination file must exist.
 * @param   {string} [archiveType] Optional archive type, by default - 'zip'.
 * @returns {object} A QPromise to a string containing the result.
 */
ArtifactoryClient.prototype.downloadFolder = function (repoKey, remotePath, destinationFile, archiveType) {
  var deferred = Q.defer(),
    self = this,
    destinationPath = path.resolve(destinationFile);

  if (!fs.existsSync(path.dirname(destinationPath))) {
    deferred.reject('The destination folder ' + path.dirname(destinationPath) + ' does not exist.');
    return deferred.promise;
  }

  var compiled = _.template(ArtifactoryClient.API.downloadFolder);
  var actionPath = compiled({
    repoKey: repoKey,
    path: remotePath
  });

  var req = request.get(this.getRequestOptions(actionPath, {archiveType: archiveType || 'zip'}));
  req.on('response', function (response) {
    if (response.statusCode === 200) {
      var stream = req.pipe(fs.createWriteStream(destinationPath));
      stream.on('finish', function () {
        deferred.resolve('Download was SUCCESSFUL');
      });
    } else {
      deferred.reject({statusCode: response.statusCode, statusMessage: response.statusMessage, response: response.body ? JSON.parse(response.body) : '<empty>', url: req.url.href});
    }
  });
  return deferred.promise;
}


/** 
 * Create a folder in artifactory.
 * @param   {string} repoKey  The key of the repo.
 * @param   {string} remotePath The path to a folder inside the repo to create.
 * @returns {object} A QPromise to a string containing the result.
 */
ArtifactoryClient.prototype.createFolder = function (repoKey, remotePath) {
  var deferred = Q.defer();
  var compiled = _.template(ArtifactoryClient.API.filePath);
  if (remotePath[remotePath.length - 1] !== '/') {
    remotePath = remotePath + '/';
  }
  var actionPath = compiled({
    repoKey: repoKey,
    filePath: remotePath
  });
  var req = request.put(this.getRequestOptions(actionPath), function (error, response) {
    if (error) {
      deferred.reject(error);
    } else if (response.statusCode === 201) {
      deferred.resolve(response.body ? JSON.parse(response.body) : "Created");
    } else {
      deferred.reject({statusCode: response.statusCode, statusMessage: response.statusMessage, response: response.body ? JSON.parse(response.body) : '<empty>', url: req.url});
    }
  });
  return deferred.promise;
}


/** 
 * Delete a folder in artifactory.
 * @param   {string} repoKey  The key of the repo.
 * @param   {string} remotePath The path to a folder inside the repo to delete.
 * @returns {object} A QPromise to a string containing the result.
 */
ArtifactoryClient.prototype.deleteFolder = function (repoKey, remotePath) {
  if (remotePath[remotePath.length - 1] !== '/') {
    remotePath = remotePath + '/';
  }
  return this._deletePath(repoKey, remotePath);
}


/** 
 * Delete a file in artifactory.
 * @param   {string} repoKey  The key of the repo.
 * @param   {string} remotePath The path to a file inside the repo to delete.
 * @returns {object} A QPromise to a string containing the result.
 */
ArtifactoryClient.prototype.deleteFile = function (repoKey, remotePath) {
  return this._deletePath(repoKey, remotePath);
}


/** 
 * Delete a path in artifactory.
 * @param   {string} repoKey  The key of the repo.
 * @param   {string} remotePath The path inside the repo to delete. It can be file or folder (ends with '/').
 * @returns {object} A QPromise to a string containing the result.
 */
ArtifactoryClient.prototype._deletePath = function (repoKey, remotePath) {
  var deferred = Q.defer();
  var compiled = _.template(ArtifactoryClient.API.filePath);
  var actionPath = compiled({
    repoKey: repoKey,
    filePath: remotePath
  });
  var opts = this.getRequestOptions(actionPath);
  var req = request.del(this.getRequestOptions(actionPath), function (error, response) {
    if (response.statusCode === 204) {
      deferred.resolve("Deleted");
    } else {
      deferred.reject({statusCode: response.statusCode, statusMessage: response.statusMessage, response: response.body ? JSON.parse(response.body) : '<empty>', url: req.url});
    }
  });
  return deferred.promise;
}


/**
 * Move a file or folder to a new path (or rename).
 * If the target path does not exist, the source item is moved and optionally renamed. 
 * Otherwise, if the target exists and it is a directory, the source is moved and placed under the target directory.
 * @param   {string}  repoKeySrc  The key of the repo where the file is stored.
 * @param   {string}  remotePathSrc The path to the file/dir inside the repo.
 * @param   {string}  repoKeyDst  The key of the repo where the file/dir will be moved.
 * @param   {string}  remotePathSrc The path to the file/dir to move: if it's file .
 * @param   {boolean} [dryrun] true for test the move (no actual move will happen)
 */
ArtifactoryClient.prototype.moveItem = function (repoKeySrc, remotePathSrc, repoKeyDst, remotePathDst, dryrun) {
  var self = this;

  // if remotePathDst is folder (ends with '/') then for move to works (not rename) it should exist or it should be file name
  // For example we're moving ("repo", "path/to/filepath.ext", "repo", "path/to/new/").
  // If folder 'new' doesn't exist then file "path/to/filepath.ext" will be renamed to "path/to/new",
  // In the most cases it's not we want. So try to create the folder first. 
  // We don't care about existence - we'll get an errpr and continue
  if (remotePathDst[remotePathDst.length - 1] === '/') {
    var deferred = Q.defer();
    // it's move, filename should not change
	// try create target folder, if it fails no problem
	this.createFolder(repoKeyDst, remotePathDst).finally(function () {
	  self._moveItem(repoKeySrc, remotePathSrc, repoKeyDst, remotePathDst, dryrun).then(function (res) {
        deferred.resolve(res);
	  }, function (error) {
        deferred.reject(error);
	  });
	});
    return deferred.promise;
  }

  // it's a rename (path/file -> newpath/newfile)
  return self._moveItem(repoKeySrc, remotePathSrc, repoKeyDst, remotePathDst, dryrun);
}


ArtifactoryClient.prototype._moveItem = function (repoKeySrc, remotePathSrc, repoKeyDst, remotePathDst, dryrun) {
  var deferred = Q.defer();
  var compiled = _.template(ArtifactoryClient.API.moveIem);
  var actionPath = compiled({
    srcRepoKey: repoKeySrc,
    srcFilePath: remotePathSrc,
    dstRepoKey: repoKeyDst,
    dstFilePath: remotePathDst
  });
  var opts = this.getRequestOptions(actionPath);
  var req = request.post(this.getRequestOptions(actionPath, dryrun ? {dry:1} : undefined), function (error, response) {
    if (error) {
      deferred.reject(error);
    } else if (response.statusCode === 200) {
      deferred.resolve(response.body ? JSON.parse(response.body) : "Moved");
    } else {
      deferred.reject({statusCode: response.statusCode, statusMessage: response.statusMessage, response: response.body ? JSON.parse(response.body) : '<empty>', url: req.url});
    }
  });
  return deferred.promise;
}


/**
 * Move a bunch of files to a new path.
 * @param   {string}   repoKeySrc  The key of the repo where the file is stored.
 * @param   {string}   remotePathSrc The path to the source dir inside the repo.
 * @param   {Function} filterCb Callback to filter source files. Only files to conform filter will be moved. NOTE: filtering is conducted on the client, not server.
 * @param   {string}   repoKeyDst  The key of the repo where the file/dir will be moved.
 * @param   {string}   remotePathSrc The path to a dir to move files into.
 * @param   {boolean}  [dryrun] true for test the move (no actual move will happen)
 */
ArtifactoryClient.prototype.moveItems = function (repoKeySrc, remotePathSrc, filterCb, repoKeyDst, remotePathDst, dryrun) {
  if (remotePathSrc[remotePathSrc.length - 1] !== '/') {
    remotePathSrc += '/';
  }
  if (remotePathDst[remotePathDst.length - 1] !== '/') {
    remotePathDst += '/';
  }
  var self = this;
  var deferred = Q.defer();
  // get source folder content
  return this.getFolderInfo(repoKeySrc, remotePathSrc).then(function (result) {
    if (!result.children) {
      return "No files in " + remotePathSrc;
    }

    self.createFolder(repoKeyDst, remotePathDst).finally(function () {
      var filesToMove = [];
      var total = 0, totalToMove = 0;
      result.children.forEach(function (item) {
        if (!item.folder && item.uri) {
          ++total;
          // get file name from full path
          var fileName = item.uri;
          var idx = item.uri.lastIndexOf('/');
          if (idx > -1) {
            fileName = item.uri.substring(idx+1);
          }
          if (filterCb && filterCb(fileName)) {
            // move the file
            filesToMove.push(item.uri);
            ++totalToMove;
          }
        }
      });
      console.log('Start moving ' + totalToMove + ' files to ' + remotePathDst + '(candidate count: ' + total + ')');
      var promises = [];
      if (filesToMove.length) {
        filesToMove.forEach(function (uri) {
          console.log('Moving ' + uri + ' into ' + remotePathDst);
          promises.push( self._moveItem(repoKeySrc, remotePathSrc + uri, repoKeyDst, remotePathDst, dryrun) );
        });
      }
      Q.all(promises).then(function (result) {
        deferred.resolve(result);
      }, function (error) {
        deferred.reject(error);
      });
    });

    return deferred.promise;
  });
}

module.exports = ArtifactoryClient;