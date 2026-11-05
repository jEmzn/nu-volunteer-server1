module.exports = async () => {
  await globalThis.__NUVOL_PG__?.stop();
};
