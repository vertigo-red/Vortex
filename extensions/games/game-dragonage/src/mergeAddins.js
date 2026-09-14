function asArray(value) {
  if (value === undefined || value === null || value === "") {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function mergeAddInItems(addinsData, manifest) {
  if (addinsData?.AddInsList === undefined) {
    return undefined;
  }

  if (
    addinsData.AddInsList === null ||
    typeof addinsData.AddInsList !== "object" ||
    Array.isArray(addinsData.AddInsList)
  ) {
    addinsData.AddInsList = {};
  }

  const list = asArray(addinsData.AddInsList.AddInItem);
  const manifestList = asArray(manifest?.Manifest?.AddInsList).flatMap((add) =>
    asArray(add?.AddInItem),
  );

  addinsData.AddInsList.AddInItem = list.concat(manifestList);
  return addinsData;
}

module.exports = {
  mergeAddInItems,
};
