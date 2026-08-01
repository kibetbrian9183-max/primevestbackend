const mongoose = require("mongoose");

let connected = false;

async function connectDB() {
  if (connected) return mongoose.connection;
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is not set — see .env.example");
  }
  await mongoose.connect(uri);
  connected = true;
  console.log("[db] connected to MongoDB");
  return mongoose.connection;
}

module.exports = { connectDB };
