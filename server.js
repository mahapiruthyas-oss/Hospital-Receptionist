require('dotenv').config();
const express = require('express');
const http = require('http');
const socketio = require('socket.io');
const connectDB = require('./db');
const { router: voiceRouter, setupMediaStream } = require('./routes/voice');

const app = express();
const server = http.createServer(app);
const io = socketio(server);

// Connect to MongoDB
connectDB();

// Middleware
app.use(express.json());
app.use(express.static('public'));
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/dashboard.html');
});

// Routes
app.use('/api/patients', require('./routes/patients'));
app.use('/voice', voiceRouter);

// Setup Media Stream WebSocket
setupMediaStream(server);

// Socket.io
io.on('connection', (socket) => {
  console.log('Client connected');
  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

app.set('io', io);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});