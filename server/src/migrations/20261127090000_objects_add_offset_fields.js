exports.up = function (knex) {
  return knex.schema.table("objects", (table) => {
    // The id of the source object the offset mesh was generated from
    table.string("source_object_id").nullable();
    // The offset value used to generate the offset mesh
    table.float("offset_value").nullable();
  });
};

exports.down = function (knex) {
  return knex.schema.table("objects", (table) => {
    table.dropColumn("source_object_id");
    table.dropColumn("offset_value");
  });
};
