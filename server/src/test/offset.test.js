const chai = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");

const expect = chai.expect;

const { createOffsetMesh } = require("../functions/offsetObjectHash");
const { meshToThreeJSON, writeOffsetFile, removeOffsetFile } = require("../functions/offsetPersistence");
const { ObjectsController } = require("../controllers/ObjectsController");
const { ProjectsController } = require("../controllers/ProjectsController");
const { saveOffset } = require("../api/threeCalculations");

const cubeStl = fs.readFileSync(path.join(__dirname, "fixtures", "cube.stl"), "utf8");

/**
 * Calls an errorHandler-wrapped api function with a fake req/res
 */
const callApi = (handler, req) =>
  new Promise((resolve, reject) => {
    handler(req, { json: resolve }, reject);
  });

describe("Offset mesh computation", () => {
  it("creates an offset mesh with the same number of faces of the source", () => {
    const mesh = createOffsetMesh(cubeStl, 2);

    expect(mesh).to.be.an("array");
    expect(mesh).to.have.lengthOf(12);
    mesh.forEach((face) => {
      expect(face.vertices).to.have.lengthOf(3);
      expect(face.normal).to.have.lengthOf(3);
    });
  });

  it("expands the mesh by the offset along the vertex normals", () => {
    const mesh = createOffsetMesh(cubeStl, 2);

    const vertices = mesh.flatMap((face) => face.vertices);
    const coords = vertices.flat();

    // Every vertex of the cube moves outward: each coordinate keeps its sign and grows
    vertices.forEach((vertex) => {
      vertex.forEach((coord) => {
        expect(Math.abs(coord)).to.be.greaterThan(10);
      });
    });

    // The corner (10, 10, 10) lies on the diagonal of all its faces, so the sum of the
    // normals is (1, 1, 1) and it moves by offset / sqrt(3) on each axis
    const diagonalCorner = vertices.find((vertex) => vertex.every((coord) => coord > 0 && coord === vertex[0]));
    expect(diagonalCorner[0]).to.be.closeTo(10 + 2 / Math.sqrt(3), 1e-6);

    // The largest displacement belongs to the corners shared by 4 faces (normals sum (1, 1, 2))
    expect(Math.max(...coords)).to.be.closeTo(10 + 4 / Math.sqrt(6), 1e-6);
    expect(Math.min(...coords)).to.be.closeTo(-(10 + 4 / Math.sqrt(6)), 1e-6);
  });

  it("shrinks the mesh with a negative offset", () => {
    const mesh = createOffsetMesh(cubeStl, -2);

    const vertices = mesh.flatMap((face) => face.vertices);
    const coords = vertices.flat();

    // Every vertex of the cube moves inward: each coordinate keeps its sign and shrinks
    vertices.forEach((vertex) => {
      vertex.forEach((coord) => {
        expect(Math.abs(coord)).to.be.lessThan(10);
      });
    });

    // The smallest displacement per axis is offset / sqrt(6) (corners shared by 4 faces)
    expect(Math.max(...coords)).to.be.closeTo(10 - 2 / Math.sqrt(6), 1e-6);
    expect(Math.min(...coords)).to.be.closeTo(-(10 - 2 / Math.sqrt(6)), 1e-6);
  });
});

describe("Offset persistence helpers", () => {
  let tempDir;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "precise-offset-"));
    process.env.FILE_PATH = tempDir;
  });

  after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.FILE_PATH;
  });

  it("converts the offset mesh into an ObjectLoader compatible JSON", () => {
    const mesh = createOffsetMesh(cubeStl, 2);
    const json = JSON.parse(meshToThreeJSON(mesh, "offset-id", "Offset GroupCube"));

    expect(json.object.uuid).to.equal("offset-id");
    expect(json.object.type).to.equal("Mesh");
    expect(json.object.name).to.equal("Offset GroupCube");

    const attributes = json.geometries[0].data.attributes;
    // 12 faces * 3 vertices * 3 coordinates
    expect(attributes.position.array).to.have.lengthOf(12 * 3 * 3);
    expect(attributes.normal.array).to.have.lengthOf(12 * 3 * 3);
    expect(attributes.color.array).to.have.lengthOf(12 * 3 * 3);
    expect(attributes.color.normalized).to.equal(true);
  });

  it("writes and removes the offset file", () => {
    const relativePath = writeOffsetFile("project-1", "object-1", "{}");
    const absolutePath = path.join(tempDir, "public", "uploads", relativePath);

    expect(relativePath).to.equal("project-1/object-1.json");
    expect(fs.existsSync(absolutePath)).to.equal(true);

    expect(removeOffsetFile(relativePath)).to.equal(true);
    expect(fs.existsSync(absolutePath)).to.equal(false);

    // Removing a missing file does not throw
    expect(removeOffsetFile(relativePath)).to.equal(false);
  });
});

describe("Save offset api", () => {
  let tempDir;
  const projectId = "project-offset";
  const sourceObjectId = "source-object-id";

  const originalGetOffsetBySourceId = ObjectsController.getOffsetBySourceId;
  const originalSaveOffsetObject = ObjectsController.saveOffsetObject;
  const originalUpdateOffsetObject = ObjectsController.updateOffsetObject;
  const originalDeleteObject = ObjectsController.deleteObject;
  const originalGetProjectById = ProjectsController.getProjectById;

  const calls = { saved: [], updated: [], deleted: [] };

  const resetCalls = () => {
    calls.saved = [];
    calls.updated = [];
    calls.deleted = [];
  };

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "precise-offset-api-"));
    process.env.FILE_PATH = tempDir;

    ProjectsController.getProjectById = async (id) => (id === projectId ? { id } : undefined);
    ObjectsController.saveOffsetObject = async (...args) => calls.saved.push(args);
    ObjectsController.updateOffsetObject = async (...args) => calls.updated.push(args);
    ObjectsController.deleteObject = async (...args) => calls.deleted.push(args);
  });

  after(() => {
    ObjectsController.getOffsetBySourceId = originalGetOffsetBySourceId;
    ObjectsController.saveOffsetObject = originalSaveOffsetObject;
    ObjectsController.updateOffsetObject = originalUpdateOffsetObject;
    ObjectsController.deleteObject = originalDeleteObject;
    ProjectsController.getProjectById = originalGetProjectById;

    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.FILE_PATH;
  });

  beforeEach(() => {
    resetCalls();
    ObjectsController.getOffsetBySourceId = async () => undefined;
  });

  it("creates and persists a new offset object", async () => {
    const res = await callApi(saveOffset, {
      params: { projectId },
      body: { sourceObjectId, sourceName: "GroupCube", offset: 2, data: cubeStl },
    });

    expect(res.removed).to.equal(false);
    expect(res.objectName).to.equal("Offset GroupCube");
    expect(res.offsetValue).to.equal(2);
    expect(res.mesh).to.have.lengthOf(12);

    // The object is saved in the objects table with the source association
    expect(calls.saved).to.have.lengthOf(1);
    const [objectId, objectName, savedProjectId, filepath, savedSourceId, offsetValue] = calls.saved[0];
    expect(objectId).to.equal(res.id);
    expect(objectName).to.equal("Offset GroupCube");
    expect(savedProjectId).to.equal(projectId);
    expect(savedSourceId).to.equal(sourceObjectId);
    expect(offsetValue).to.equal(2);

    // The file is saved on the disk and is reloadable
    const absolutePath = path.join(tempDir, "public", "uploads", filepath);
    expect(fs.existsSync(absolutePath)).to.equal(true);
    const json = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
    expect(json.object.uuid).to.equal(res.id);
    expect(json.object.name).to.equal("Offset GroupCube");
  });

  it("replaces the previous offset object instead of stacking a new one", async () => {
    ObjectsController.getOffsetBySourceId = async () => ({ id: "existing-offset-id", objectPath: `${projectId}/existing-offset-id.json` });

    const res = await callApi(saveOffset, {
      params: { projectId },
      body: { sourceObjectId, sourceName: "GroupCube", offset: 3, data: cubeStl },
    });

    // The id of the previous offset object is kept, no new object is inserted
    expect(res.id).to.equal("existing-offset-id");
    expect(calls.saved).to.have.lengthOf(0);
    expect(calls.updated).to.have.lengthOf(1);
    expect(calls.updated[0]).to.deep.equal(["existing-offset-id", 3]);

    const absolutePath = path.join(tempDir, "public", "uploads", projectId, "existing-offset-id.json");
    expect(fs.existsSync(absolutePath)).to.equal(true);
  });

  it("removes the offset object when the offset is 1 (undo)", async () => {
    // The offset file exists on the disk
    writeOffsetFile(projectId, "existing-offset-id", "{}");
    ObjectsController.getOffsetBySourceId = async () => ({ id: "existing-offset-id", objectPath: `${projectId}/existing-offset-id.json` });

    const res = await callApi(saveOffset, {
      params: { projectId },
      body: { sourceObjectId, sourceName: "GroupCube", offset: 1, data: cubeStl },
    });

    expect(res.removed).to.equal(true);
    expect(calls.deleted).to.deep.equal([["existing-offset-id"]]);
    expect(calls.saved).to.have.lengthOf(0);

    const absolutePath = path.join(tempDir, "public", "uploads", projectId, "existing-offset-id.json");
    expect(fs.existsSync(absolutePath)).to.equal(false);
  });

  it("does nothing on undo when no offset object exists", async () => {
    const res = await callApi(saveOffset, {
      params: { projectId },
      body: { sourceObjectId, sourceName: "GroupCube", offset: 1, data: cubeStl },
    });

    expect(res.removed).to.equal(true);
    expect(calls.deleted).to.have.lengthOf(0);
  });

  it("returns 400 when required fields are missing", async () => {
    try {
      await callApi(saveOffset, { params: { projectId }, body: { sourceObjectId, offset: 2 } });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err.statusCode).to.equal(400);
    }
  });

  it("returns 404 when the project does not exist", async () => {
    try {
      await callApi(saveOffset, {
        params: { projectId: "unknown-project" },
        body: { sourceObjectId, sourceName: "GroupCube", offset: 2, data: cubeStl },
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err.statusCode).to.equal(404);
    }
  });
});
