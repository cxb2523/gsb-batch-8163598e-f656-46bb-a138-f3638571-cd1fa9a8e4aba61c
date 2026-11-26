const fs = require("fs");
const path = require("path");

// Color of the offset mesh (#fff000), the same used by the client
const OFFSET_COLOR = 16773120;

/**
 * Base directory of the uploaded files
 * @returns The absolute path of the uploads directory
 */
const uploadsBaseDir = () => path.join(process.env.FILE_PATH || process.cwd(), "public", "uploads");

/**
 * The path of the offset file relative to the uploads directory
 * @param {String} projectId The id of the project
 * @param {String} objectId The id of the offset object
 * @returns The relative path of the offset file
 */
const offsetRelativePath = (projectId, objectId) => `${projectId}/${objectId}.json`;

/**
 * Writes the offset mesh file on the disk, creates the project folder if missing
 * @param {String} projectId The id of the project
 * @param {String} objectId The id of the offset object
 * @param {String} content The content of the file
 * @returns The path of the file relative to the uploads directory
 */
const writeOffsetFile = (projectId, objectId, content) => {
  const dir = path.join(uploadsBaseDir(), projectId);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const relativePath = offsetRelativePath(projectId, objectId);
  fs.writeFileSync(path.join(uploadsBaseDir(), relativePath), content);

  return relativePath;
};

/**
 * Removes the offset mesh file from the disk
 * @param {String} relativePath The path of the file relative to the uploads directory
 * @returns True if the file was removed, false if the file was missing
 */
const removeOffsetFile = (relativePath) => {
  const filePath = path.join(uploadsBaseDir(), relativePath);

  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }

  return false;
};

/**
 * Converts the offset mesh (list of faces with normal and vertices) into a
 * THREE.ObjectLoader compatible JSON, so the offset object can be reloaded
 * by the client like every other saved object of the project.
 * @param {Array} meshObjects List of faces ({ face, normal, vertices })
 * @param {String} objectId The id of the offset object
 * @param {String} objectName The name of the offset object
 * @returns The JSON string of the mesh
 */
const meshToThreeJSON = (meshObjects, objectId, objectName) => {
  const positions = [];
  const normals = [];
  const colors = [];

  for (const face of meshObjects) {
    for (const vertex of face.vertices) {
      positions.push(vertex[0], vertex[1], vertex[2]);
      normals.push(face.normal[0], face.normal[1], face.normal[2]);
      colors.push(255, 255, 255);
    }
  }

  const geometryUuid = `${objectId}-geometry`;
  const materialUuid = `${objectId}-material`;

  const json = {
    metadata: { version: 4.5, type: "Object", generator: "PreciseOffset" },
    geometries: [
      {
        uuid: geometryUuid,
        type: "BufferGeometry",
        data: {
          attributes: {
            position: { itemSize: 3, type: "Float32Array", array: positions, normalized: false },
            normal: { itemSize: 3, type: "Float32Array", array: normals, normalized: false },
            color: { itemSize: 3, type: "Uint8Array", array: colors, normalized: true },
          },
        },
      },
    ],
    materials: [
      {
        uuid: materialUuid,
        type: "MeshStandardMaterial",
        color: OFFSET_COLOR,
        roughness: 1,
        metalness: 0,
        side: 2,
        vertexColors: true,
      },
    ],
    object: {
      uuid: objectId,
      type: "Mesh",
      name: objectName,
      layers: 1,
      matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      geometry: geometryUuid,
      material: materialUuid,
    },
  };

  return JSON.stringify(json);
};

module.exports = { offsetRelativePath, writeOffsetFile, removeOffsetFile, meshToThreeJSON };
