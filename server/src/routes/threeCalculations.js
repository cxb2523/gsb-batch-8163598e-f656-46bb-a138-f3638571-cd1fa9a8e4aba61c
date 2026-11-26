const express = require("express");
const api = require("../api/threeCalculations");

const router = express.Router();

router.post("/offset", api.calculateOffset);
router.post("/offset/:projectId", api.saveOffset);

module.exports = router;
