import PropTypes from "prop-types";
import React, { useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { useParams } from "react-router";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import offsetIcon from "../../assets/images/icons/black/pencil-ruler-solid.svg";
import { dispatchError } from "../../features/error/errorSlice";
import { setLoading } from "../../features/loading/loadingSlice";
import { getScene } from "../../features/scene/sceneSlice";
import { useGetObjectsByProjectId } from "../../hooks/useGetObjectsByProjectId";
import { saveOffsetObject } from "../../services/api";
import { findById } from "../../utils/common-utils";
import { createMeshFromObject } from "../../utils/functions/createMeshFromObject";
import Button from "../atoms/Button/Button";

export default function Offset({ meshId }) {
  const scene = useSelector(getScene);
  const dispatch = useDispatch();
  const { id: projectId } = useParams();

  const [offset, setOffset] = useState();

  const { fetchGetObjectsByProjectId } = useGetObjectsByProjectId();

  const meshToOffset = findById(meshId)(scene.children);
  const offsetName = "Offset " + meshToOffset.name;

  const changeScale = (e) => {
    const { value } = e.target;
    setOffset(value);
  };

  const applyOffset = async () => {
    if (offset === undefined || offset === "") return;

    dispatch(setLoading(true));

    try {
      // 1. Export the source mesh as an ascii STL file
      const exporter = new STLExporter();
      const result = exporter.parse(meshToOffset, { binary: false });

      // 2. The server computes the offset mesh from the STL data and persists it as an
      //    object of the project. Applying the offset again replaces the previous offset
      //    object, an offset value of 1 removes it (undo).
      const response = await saveOffsetObject(projectId, {
        sourceObjectId: meshId,
        sourceName: meshToOffset.name,
        offset: Number(offset),
        data: result,
      });

      // 3. Remove the previous offset mesh of the source mesh (replace or undo)
      scene.children.filter((item) => item.name === offsetName).forEach((item) => scene.remove(item));

      if (!response.data.removed) {
        const mesh = await createMeshFromObject(response.data.mesh);
        mesh.name = response.data.objectName;
        // The mesh uuid matches the id of the object saved on the db
        mesh.uuid = response.data.id;

        // If the source mesh is clipped, the offset mesh follows the same clipping planes
        const clippingPlanes = meshToOffset.material.clippingPlanes;
        if (clippingPlanes && clippingPlanes.length > 0) {
          mesh.material.clippingPlanes = clippingPlanes;
          mesh.material.clipIntersection = meshToOffset.material.clipIntersection;
        }

        scene.add(mesh);
      }

      // Refresh the saved objects list with the new/removed offset object
      fetchGetObjectsByProjectId(projectId);
    } catch (error) {
      console.log(error);
      dispatch(dispatchError("Error applying the offset"));
    }

    dispatch(setLoading(false));
  };

  return (
    <>
      <div className="flex">
        <input type="number" className="mr-2 form__input px-1 py-0 text-base" step="0.1" onChange={changeScale} />
        <Button typeClass="btn--img btn__icon-sm" img={offsetIcon} onClick={applyOffset} />
      </div>
    </>
  );
}

Offset.propTypes = {
  meshId: PropTypes.string.isRequired,
};
