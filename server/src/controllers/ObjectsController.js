const { ObjectsModel } = require("../models/ObjectsModel");

class ObjectsController {
  /**
   * Gets the object by uuid
   * @param {String} objectId The uuid of the object
   * @returns The object by uuid
   */
  static getObjectById(id) {
    return ObjectsModel.query().findById(id);
  }

  /**
   * Gets the list of objects of a project
   * @param {String} projectId Project ID
   * @returns List of objects by project id only json field
   */
  static getObjectsPathByProjectId(projectId) {
    return ObjectsModel.query().select("objects.object_path").where("objects.project_id", projectId);
  }

  static getObjectsByProjectId(projectId) {
    return ObjectsModel.query().select().where("objects.project_id", projectId);
  }

  /**
   * Saves the object on the db
   * @param {Object} object
   * @returns The object inserted
   * Method Not used
   */
  static createObject(object) {
    return ObjectsModel.query().insert({
      id: object.objectId,
      project_id: object.projectId,
      object: object.object,
    });
  }

  /**
   * Saves the object in the db
   * @param {Object} object The id of the mesh
   * @param {String} projectId
   * @param {String} filepath
   * @returns
   */
  static saveObject(objectId, objectName, projectId, filepath) {
    return ObjectsModel.query().insert({
      id: objectId,
      project_id: projectId,
      object_name: objectName,
      object_path: filepath,
    });
  }

  static deleteObject(id) {
    return ObjectsModel.query().deleteById(id);
  }

  /**
   * Gets the offset object associated to a source object of a project
   * @param {String} projectId The id of the project
   * @param {String} sourceObjectId The id of the source object the offset was generated from
   * @returns The offset object or undefined
   */
  static getOffsetBySourceId(projectId, sourceObjectId) {
    return ObjectsModel.query().findOne("objects.project_id", projectId).where("objects.source_object_id", sourceObjectId);
  }

  /**
   * Saves the offset object in the db keeping the association with the source object
   * @param {String} objectId The id of the offset object
   * @param {String} objectName The name of the offset object
   * @param {String} projectId The id of the project
   * @param {String} filepath The path of the offset file
   * @param {String} sourceObjectId The id of the source object
   * @param {Number} offsetValue The offset value used to generate the mesh
   * @returns The object inserted
   */
  static saveOffsetObject(objectId, objectName, projectId, filepath, sourceObjectId, offsetValue) {
    return ObjectsModel.query().insert({
      id: objectId,
      project_id: projectId,
      object_name: objectName,
      object_path: filepath,
      source_object_id: sourceObjectId,
      offset_value: offsetValue,
    });
  }

  /**
   * Updates the offset value of an existing offset object
   * @param {String} id The id of the offset object
   * @param {Number} offsetValue The new offset value
   * @returns The updated object
   */
  static updateOffsetObject(id, offsetValue) {
    return ObjectsModel.query().patchAndFetchById(id, { offset_value: offsetValue });
  }
}

module.exports = { ObjectsController };
