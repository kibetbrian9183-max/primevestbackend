function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const status = err.response?.status || 500;
  const darajaError = err.response?.data;
  console.error("[error]", req.method, req.originalUrl, darajaError || err.message);
  res.status(status >= 400 && status < 600 ? status : 500).json({
    error: darajaError?.errorMessage || err.message || "Unexpected server error",
    details: darajaError || undefined,
  });
}

module.exports = { errorHandler };
