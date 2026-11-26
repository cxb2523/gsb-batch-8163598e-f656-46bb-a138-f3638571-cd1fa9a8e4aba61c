# Offset

### Usage

1. The user chooses the mesh to offset clicking to the dedicated button
2. The button opens an input and a button
3. The user chooses the offset to add to the mesh
4. The user clicks the button
5. The system applies the offset to the mesh and saves it on the project

### How offset works

When the user chooses the mesh, the system takes the uuid of the selected mesh and searches the mesh object in the scene object through the function findById. When the user applies the offset, the source mesh is exported as an ascii STL file and sent to the server (`POST /api/offset/:projectId`) together with the offset value and the id of the source mesh.

The server computes the offset mesh from the STL data: for every vertex it sums the normals of all the faces that share the vertex, normalizes the result and moves the vertex along it by the offset value. A positive offset expands the mesh, a negative offset shrinks it.

The offset mesh is persisted as a standalone object of the project: the server saves a THREE.ObjectLoader compatible JSON file in the uploads folder of the project and a row in the `objects` table (reusing the `objectPath`/`objectName` structure). The row keeps the association with the source mesh through the `source_object_id` column and stores the applied value in `offset_value`, so the offset object is saved, shared and exported like every other object of the project and is restored when the project is loaded.

The offset object is linked to its source mesh:

- applying the offset again on the same mesh **replaces** the previous offset object (the id is kept, the file is overwritten) instead of stacking a new one
- an offset value equal to **1** removes (undoes) the offset object: the row and the file are deleted and the offset mesh is removed from the scene
- deleting the source mesh deletes its offset object as well

When the clipping is enabled, the offset mesh is cut by the same clipping planes of its source mesh; when the clipping is disabled the offset mesh is shown again in its full form.

If the file of an offset object is missing when the project is loaded, an error is shown but the loading of the other objects continues.
