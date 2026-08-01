const express = require("express");
const Notification = require("../models/Notification");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.get("/", requireAuth, async (req, res, next) => {
  try {
    const notifications = await Notification.find({
      $or: [{ user: req.userId }, { user: null }],
    })
      .sort({ createdAt: -1 })
      .limit(50);
    res.json({ notifications });
  } catch (err) {
    next(err);
  }
});

router.patch("/:id/read", requireAuth, async (req, res, next) => {
  try {
    await Notification.findOneAndUpdate(
      { _id: req.params.id, $or: [{ user: req.userId }, { user: null }] },
      { read: true }
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
