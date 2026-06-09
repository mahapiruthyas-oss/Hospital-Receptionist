const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

// Patient Schema
const patientSchema = new mongoose.Schema({
  hospitalId: { type: String, default: 'H001' },
  name: String,
  mobile: String,
  doctor: String,
  tokenNumber: Number,
  status: { type: String, default: 'waiting' },
  createdAt: { type: Date, default: Date.now }
});

const Patient = mongoose.model('Patient', patientSchema);

// GET all today's patients
router.get('/', async (req, res) => {
  const today = new Date();
  today.setHours(0,0,0,0);
  const patients = await Patient.find({
    hospitalId: req.query.hospitalId || 'H001',
    createdAt: { $gte: today }
  }).sort({ tokenNumber: 1 });
  res.json(patients);
});

// POST add new patient
router.post('/', async (req, res) => {
  const count = await Patient.countDocuments();
  const patient = new Patient({
    ...req.body,
    tokenNumber: count + 1
  });
  await patient.save();
  const io = req.app.get('io');
  io.emit('patientAdded', patient);
  res.json(patient);
});

// PUT mark next patient as seen
router.put('/next', async (req, res) => {
  const patient = await Patient.findOneAndUpdate(
    { hospitalId: req.body.hospitalId || 'H001', status: 'waiting' },
    { status: 'seen' },
    { sort: { tokenNumber: 1 }, new: true }
  );
  const io = req.app.get('io');
  io.emit('patientCalled', patient);
  res.json(patient);
});

module.exports = router;