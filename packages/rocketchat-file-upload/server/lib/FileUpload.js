import { Meteor } from 'meteor/meteor';
import fs from 'fs';
import stream from 'stream';
import mime from 'mime-type/with-db';
import Future from 'fibers/future';
import sharp from 'sharp';
import { Cookies } from 'meteor/ostrio:cookies';
import { UploadFS } from 'meteor/jalik:ufs';
import { settings } from 'meteor/rocketchat:settings';
import * as Models from 'meteor/rocketchat:models';
import { FileUpload as _FileUpload } from '../../lib/FileUpload';
import { roomTypes } from 'meteor/rocketchat:utils';

const cookie = new Cookies();

export const FileUpload = Object.assign(_FileUpload, {
	handlers: {},

	configureUploadsStore(store, name, options) {
		const type = name.split(':').pop();
		const stores = UploadFS.getStores();
		delete stores[name];

		return new UploadFS.store[store](Object.assign({
			name,
		}, options, FileUpload[`default${ type }`]()));
	},

	defaultUploads() {
		return {
			collection: Models.Uploads.model,
			filter: new UploadFS.Filter({
				onCheck: FileUpload.validateFileUpload,
			}),
			getPath(file) {
				return `${ settings.get('uniqueID') }/uploads/${ file.rid }/${ file.userId }/${ file._id }`;
			},
			onValidate: FileUpload.uploadsOnValidate,
			onRead(fileId, file, req, res) {
				if (!FileUpload.requestCanAccessFiles(req)) {
					res.writeHead(403);
					return false;
				}

				res.setHeader('content-disposition', `attachment; filename="${ encodeURIComponent(file.name) }"`);
				return true;
			},
		};
	},

	defaultAvatars() {
		return {
			collection: Models.Avatars.model,
			// filter: new UploadFS.Filter({
			// 	onCheck: FileUpload.validateFileUpload
			// }),
			getPath(file) {
				return `${ settings.get('uniqueID') }/avatars/${ file.userId }`;
			},
			onValidate: FileUpload.avatarsOnValidate,
			onFinishUpload: FileUpload.avatarsOnFinishUpload,
		};
	},

	defaultUserDataFiles() {
		return {
			collection: Models.UserDataFiles.model,
			getPath(file) {
				return `${ settings.get('uniqueID') }/uploads/userData/${ file.userId }`;
			},
			onValidate: FileUpload.uploadsOnValidate,
			onRead(fileId, file, req, res) {
				if (!FileUpload.requestCanAccessFiles(req)) {
					res.writeHead(403);
					return false;
				}

				res.setHeader('content-disposition', `attachment; filename="${ encodeURIComponent(file.name) }"`);
				return true;
			},
		};
	},

	avatarsOnValidate(file) {
		if (settings.get('Accounts_AvatarResize') !== true) {
			return;
		}

		const tempFilePath = UploadFS.getTempFilePath(file._id);

		const height = settings.get('Accounts_AvatarSize');
		const future = new Future();

		const s = sharp(tempFilePath);
		s.rotate();
		// Get metadata to resize the image the first time to keep "inside" the dimensions
		// then resize again to create the canvas around

		s.metadata(Meteor.bindEnvironment((err, metadata) => {
			if (!metadata) {
				metadata = {};
			}

			s.flatten({ background: '#FFFFFF' })
				.jpeg()
				.resize({
					width: Math.min(height || 0, metadata.width || Infinity),
					height: Math.min(height || 0, metadata.height || Infinity),
					fit: sharp.fit.cover,
				})
				.pipe(sharp()
					.resize({
						height,
						width: height,
						fit: sharp.fit.contain,
						background: '#FFFFFF',
					})
				)
				// Use buffer to get the result in memory then replace the existing file
				// There is no option to override a file using this library
				.toBuffer()
				.then(Meteor.bindEnvironment((outputBuffer) => {
					fs.writeFile(tempFilePath, outputBuffer, Meteor.bindEnvironment((err) => {
						if (err != null) {
							console.error(err);
						}
						const { size } = fs.lstatSync(tempFilePath);
						this.getCollection().direct.update({ _id: file._id }, { $set: { size } });
						future.return();
					}));
				}));
		}));

		return future.wait();
	},

	resizeImagePreview(file) {
		file = Models.Uploads.findOneById(file._id);
		file = FileUpload.addExtensionTo(file);
		const image = FileUpload.getStore('Uploads')._store.getReadStream(file._id, file);

		const transformer = sharp()
			.resize({ width: 32, height: 32, fit: 'inside' })
			.jpeg()
			.blur();
		const result = transformer.toBuffer().then((out) => out.toString('base64'));
		image.pipe(transformer);
		return result;
	},

	uploadsOnValidate(file) {
		if (!/^image\/((x-windows-)?bmp|p?jpeg|png)$/.test(file.type)) {
			return;
		}

		const tmpFile = UploadFS.getTempFilePath(file._id);

		const fut = new Future();

		const s = sharp(tmpFile);
		s.metadata(Meteor.bindEnvironment((err, metadata) => {
			if (err != null) {
				console.error(err);
				return fut.return();
			}

			const identify = {
				format: metadata.format,
				size: {
					width: metadata.width,
					height: metadata.height,
				},
			};

			const reorientation = (cb) => {
				if (!metadata.orientation) {
					return cb();
				}
				s.rotate()
					.toFile(`${ tmpFile }.tmp`)
					.then(Meteor.bindEnvironment(() => {
						fs.unlink(tmpFile, Meteor.bindEnvironment(() => {
							fs.rename(`${ tmpFile }.tmp`, tmpFile, Meteor.bindEnvironment(() => {
								cb();
							}));
						}));
					})).catch((err) => {
						console.error(err);
						fut.return();
					});

				return;
			};

			reorientation(() => {
				const { size } = fs.lstatSync(tmpFile);
				this.getCollection().direct.update({ _id: file._id }, {
					$set: { size, identify },
				});

				fut.return();
			});
		}));

		return fut.wait();
	},

	avatarsOnFinishUpload(file) {
		// update file record to match user's username
		const user = Models.Users.findOneById(file.userId);
		const oldAvatar = Models.Avatars.findOneByName(user.username);
		if (oldAvatar) {
			Models.Avatars.deleteFile(oldAvatar._id);
		}
		Models.Avatars.updateFileNameById(file._id, user.username);
		// console.log('upload finished ->', file);
	},

	requestCanAccessFiles({ headers = {}, query = {} }) {
		if (!settings.get('FileUpload_ProtectFiles')) {
			return true;
		}

		let { rc_uid, rc_token, rc_rid, rc_room_type } = query;

		if (!rc_uid && headers.cookie) {
			rc_uid = cookie.get('rc_uid', headers.cookie);
			rc_token = cookie.get('rc_token', headers.cookie);
			rc_rid = cookie.get('rc_rid', headers.cookie);
			rc_room_type = cookie.get('rc_room_type', headers.cookie);
		}

		const isAuthorizedByCookies = rc_uid && rc_token && Models.Users.findOneByIdAndLoginToken(rc_uid, rc_token);
		const isAuthorizedByHeaders = headers['x-user-id'] && headers['x-auth-token'] && Models.Users.findOneByIdAndLoginToken(headers['x-user-id'], headers['x-auth-token']);
		const isAuthorizedByRoom = rc_room_type && roomTypes.getConfig(rc_room_type).canAccessUploadedFile({ rc_uid, rc_rid, rc_token });
		return isAuthorizedByCookies || isAuthorizedByHeaders || isAuthorizedByRoom;
	},
	addExtensionTo(file) {
		if (mime.lookup(file.name) === file.type) {
			return file;
		}

		const ext = mime.extension(file.type);
		if (ext && false === new RegExp(`\.${ ext }$`, 'i').test(file.name)) {
			file.name = `${ file.name }.${ ext }`;
		}

		return file;
	},

	getStore(modelName) {
		const storageType = settings.get('FileUpload_Storage_Type');
		const handlerName = `${ storageType }:${ modelName }`;

		return this.getStoreByName(handlerName);
	},

	getStoreByName(handlerName) {
		if (this.handlers[handlerName] == null) {
			console.error(`Upload handler "${ handlerName }" does not exists`);
		}
		return this.handlers[handlerName];
	},

	get(file, req, res, next) {
		const store = this.getStoreByName(file.store);
		if (store && store.get) {
			return store.get(file, req, res, next);
		}
		res.writeHead(404);
		res.end();
	},

	copy(file, targetFile) {
		const store = this.getStoreByName(file.store);
		const out = fs.createWriteStream(targetFile);

		file = FileUpload.addExtensionTo(file);

		if (store.copy) {
			store.copy(file, out);
			return true;
		}

		return false;
	},
});

export class FileUploadClass {
	constructor({ name, model, store, get, insert, getStore, copy }) {
		this.name = name;
		this.model = model || this.getModelFromName();
		this._store = store || UploadFS.getStore(name);
		this.get = get;
		this.copy = copy;

		if (insert) {
			this.insert = insert;
		}

		if (getStore) {
			this.getStore = getStore;
		}

		FileUpload.handlers[name] = this;
	}

	getStore() {
		return this._store;
	}

	get store() {
		return this.getStore();
	}

	set store(store) {
		this._store = store;
	}

	getModelFromName() {
		return Models[this.name.split(':')[1]];
	}

	delete(fileId) {
		if (this.store && this.store.delete) {
			this.store.delete(fileId);
		}

		return this.model.deleteFile(fileId);
	}

	deleteById(fileId) {
		const file = this.model.findOneById(fileId);

		if (!file) {
			return;
		}

		const store = FileUpload.getStoreByName(file.store);

		return store.delete(file._id);
	}

	deleteByName(fileName) {
		const file = this.model.findOneByName(fileName);

		if (!file) {
			return;
		}

		const store = FileUpload.getStoreByName(file.store);

		return store.delete(file._id);
	}

	insert(fileData, streamOrBuffer, cb) {
		fileData.size = parseInt(fileData.size) || 0;

		// Check if the fileData matches store filter
		const filter = this.store.getFilter();
		if (filter && filter.check) {
			filter.check(fileData);
		}

		const fileId = this.store.create(fileData);
		const token = this.store.createToken(fileId);
		const tmpFile = UploadFS.getTempFilePath(fileId);

		try {
			if (streamOrBuffer instanceof stream) {
				streamOrBuffer.pipe(fs.createWriteStream(tmpFile));
			} else if (streamOrBuffer instanceof Buffer) {
				fs.writeFileSync(tmpFile, streamOrBuffer);
			} else {
				throw new Error('Invalid file type');
			}

			const file = Meteor.call('ufsComplete', fileId, this.name, token);

			if (cb) {
				cb(null, file);
			}

			return file;
		} catch (e) {
			if (cb) {
				cb(e);
			} else {
				throw e;
			}
		}
	}
}
