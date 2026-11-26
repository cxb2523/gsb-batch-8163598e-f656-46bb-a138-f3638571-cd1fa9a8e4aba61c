const crypto = require("crypto");
const { errorHandler } = require("../utils");
const { HttpError } = require("../error");
const { memoize } = require("../memoizer/memoize");
const { createOffsetMesh } = require("../functions/offsetObjectHash");
const { writeOffsetFile, removeOffsetFile, meshToThreeJSON } = require("../functions/offsetPersistence");
const { ObjectsController } = require("../controllers/ObjectsController");
const { ProjectsController } = require("../controllers/ProjectsController");

const createOffsetMeshMemo = memoize(createOffsetMesh);

const calculateOffset = errorHandler((req, res) => {
  const { data, offset } = req.body;

  const mesh = createOffsetMeshMemo(data, offset);

  return mesh;
});

/**
 * Applies the offset to the STL data of a source object and persists the result
 * as a standalone object of the project (objects table + file on disk).
 * - A new offset creates a new row in the objects table and a new file
 * - Re-applying the offset to the same source object replaces the previous offset object
 * - An offset value of 1 removes (undoes) the existing offset object
 */
const saveOffset = errorHandler(async (req, res) => {
  const { projectId } = req.params;
  const { sourceObjectId, sourceName, offset, data } = req.body;

  if (!sourceObjectId || offset === undefined || offset === null || !data) {
    throw new HttpError(400, "Missing required fields: sourceObjectId, offset, data");
  }

  const offsetValue = Number(offset);

  if (Number.isNaN(offsetValue)) {
    throw new HttpError(400, "The offset must be a number");
  }

  // Checks if the project exists
  const project = await ProjectsController.getProjectById(projectId);

  if (!project) throw new HttpError(404, "Project not found");

  // The offset object is associated to the source object: only one offset per source object
  const existing = await ObjectsController.getOffsetBySourceId(projectId, sourceObjectId);

  // An offset value of 1 means undo: remove the persisted offset object if present
  if (offsetValue === 1) {
    if (existing) {
      removeOffsetFile(existing.objectPath);
      await ObjectsController.deleteObject(existing.id);
    }

    return { removed: true, message: "Offset removed" };
  }

  const mesh = createOffsetMeshMemo(data, offsetValue);

  // On replace the id of the previous offset object is kept
  const objectId = existing ? existing.id : crypto.randomUUID();
  const objectName = "Offset " + (sourceName || sourceObjectId);

  const content = meshToThreeJSON(mesh, objectId, objectName);
  const filepath = writeOffsetFile(projectId, objectId, content);

  if (existing) {
    await ObjectsController.updateOffsetObject(objectId, offsetValue);
  } else {
    await ObjectsController.saveOffsetObject(objectId, objectName, projectId, filepath, sourceObjectId, offsetValue);
  }

  return {
    removed: false,
    id: objectId,
    objectName,
    objectPath: "uploads/" + filepath,
    offsetValue,
    mesh,
  };
});

module.exports = { calculateOffset, saveOffset };
