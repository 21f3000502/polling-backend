const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// In-memory data structures
let teachers = {};      // { socketId: { id, name } }
let participants = {};  // { socketId: { name, voted, sessionId } }
let sessionIdMap = {};  // { sessionId: socketId }
let kickedSessionIds = new Set();
let currentPoll = null; // { id, question, options, timer, votes, startTime }
let pollHistory = [];
let pollTimeout = null;

// Utility: Check if all students have voted
function allStudentsVoted() {
  return Object.values(participants).length > 0 &&
    Object.values(participants).every(p => p.voted);
}

// Input validation for poll creation
function validatePoll(pollData) {
  if (!pollData.question || !pollData.question.trim()) return 'Question cannot be empty.';
  if (!Array.isArray(pollData.options) || pollData.options.length < 2)
    return 'At least two options are required.';
  const trimmed = pollData.options.map(opt => (opt || '').trim());
  if (trimmed.some(opt => !opt)) return 'All options must be non-empty.';
  if (new Set(trimmed).size !== trimmed.length) return 'Options must be unique.';
  if (typeof pollData.timer !== 'number' || pollData.timer < 10 || pollData.timer > 300)
    return 'Timer must be between 10 and 300 seconds.';
  if (typeof pollData.correctIndex !== 'number' || pollData.correctIndex < 0 || pollData.correctIndex >= trimmed.length)
    return 'A valid correct answer must be selected.';
  return null;
}

// Socket.io connection
io.on('connection', (socket) => {
  // TEACHER SIGNUP
  socket.on('teacher_signup', (teacherData) => {
    const teacherId = uuidv4();
    teachers[socket.id] = { id: teacherId, name: teacherData.name || 'Teacher' };
    socket.emit('teacher_signed_up', { teacherId });
  });

  // STUDENT REGISTERS NAME (per tab/session)
  socket.on('register_student', ({ name, sessionId }) => {
    if (!name || !sessionId) {
      socket.emit('error', 'Name and sessionId are required.');
      return;
    }
    if (kickedSessionIds.has(sessionId)) {
      socket.emit('kicked_out');
      return;
    }
    // Remove previous mapping if exists
    if (sessionIdMap[sessionId]) {
      delete participants[sessionIdMap[sessionId]];
    }
    participants[socket.id] = { name, voted: false, sessionId };
    sessionIdMap[sessionId] = socket.id;
    socket.emit('student_registered', { name, sessionId });
    io.emit('participants', getParticipantsList());
  });

  // CREATE POLL (Teacher)
  socket.on('create_poll', (pollData) => {
    if (!teachers[socket.id]) {
      socket.emit('error', 'Only teachers can create polls.');
      return;
    }
    if (currentPoll && !allStudentsVoted()) {
      socket.emit('error', 'Wait until all students have answered.');
      return;
    }
    const validationError = validatePoll(pollData);
    if (validationError) {
      socket.emit('error', validationError);
      return;
    }
    if (currentPoll) {
      pollHistory.push({
        question: currentPoll.question,
        options: currentPoll.options,
        votes: currentPoll.votes,
        correctIndex: currentPoll.correctIndex
      });
    }
    currentPoll = {
      id: Date.now(),
      question: pollData.question,
      options: pollData.options,
      timer: pollData.timer || 60,
      votes: Array(pollData.options.length).fill(0),
      startTime: Date.now(),
      correctIndex: pollData.correctIndex
    };
    Object.keys(participants).forEach(pid => participants[pid].voted = false);
    io.emit('new_poll', currentPoll);

    if (pollTimeout) clearTimeout(pollTimeout);
    pollTimeout = setTimeout(() => {
      io.emit('poll_results', {
        pollId: currentPoll.id,
        votes: currentPoll.votes
      });
      pollHistory.push({
        question: currentPoll.question,
        options: currentPoll.options,
        votes: currentPoll.votes,
        correctIndex: currentPoll.correctIndex
      });
      currentPoll = null;
      io.emit('poll_ended');
    }, (currentPoll.timer || 60) * 1000);
  });

  // STUDENT SUBMITS ANSWER
  socket.on('submit_answer', ({ pollId, optionIndex, sessionId }) => {
    if (!currentPoll || currentPoll.id !== pollId) {
      socket.emit('error', 'No active poll or poll mismatch.');
      return;
    }
    if (!participants[socket.id]) {
      socket.emit('error', 'You are not registered.');
      return;
    }
    if (participants[socket.id].voted) {
      socket.emit('error', 'You have already voted.');
      return;
    }
    participants[socket.id].voted = true;
    currentPoll.votes[optionIndex] += 1;
    io.emit('poll_results', {
      pollId: currentPoll.id,
      votes: currentPoll.votes
    });
    if (allStudentsVoted()) {
      if (pollTimeout) clearTimeout(pollTimeout);
      pollHistory.push({
        question: currentPoll.question,
        options: currentPoll.options,
        votes: currentPoll.votes,
        correctIndex: currentPoll.correctIndex
      });
      currentPoll = null;
      io.emit('poll_ended');
    }
  });

  // TEACHER ENDS POLL MANUALLY
  socket.on('end_poll', () => {
    if (!teachers[socket.id]) {
      socket.emit('error', 'Only teachers can end polls.');
      return;
    }
    if (currentPoll) {
      pollHistory.push({
        question: currentPoll.question,
        options: currentPoll.options,
        votes: currentPoll.votes,
        correctIndex: currentPoll.correctIndex
      });
      currentPoll = null;
      if (pollTimeout) clearTimeout(pollTimeout);
      io.emit('poll_ended');
    }
  });

  // TEACHER CLOSES SESSION (removes all students, ends poll)
  socket.on('close_session', () => {
    if (!teachers[socket.id]) {
      socket.emit('error', 'Only teachers can close the session.');
      return;
    }
    io.emit('session_closed');
    participants = {};
    sessionIdMap = {};
    kickedSessionIds.clear();
    if (currentPoll) {
      pollHistory.push({
        question: currentPoll.question,
        options: currentPoll.options,
        votes: currentPoll.votes,
        correctIndex: currentPoll.correctIndex
      });
      currentPoll = null;
      if (pollTimeout) clearTimeout(pollTimeout);
    }
  });

  // GET POLL HISTORY
  socket.on('get_poll_history', () => {
    socket.emit('poll_history', pollHistory);
  });

  // GET CURRENT POLL (for refresh/reconnect)
  socket.on('get_current_poll', () => {
    if (currentPoll) {
      socket.emit('new_poll', currentPoll);
    }
  });

  // CHAT
  socket.on('chat_message', (msg) => {
    io.emit('chat_message', {
      sender: participants[socket.id]?.name || teachers[socket.id]?.name || 'Unknown',
      text: msg
    });
  });

  // TEACHER KICKS STUDENT
  socket.on('kick_participant', (sessionId) => {
    if (!teachers[socket.id]) {
      socket.emit('error', 'Only teachers can kick participants.');
      return;
    }
    kickedSessionIds.add(sessionId);
    const sid = sessionIdMap[sessionId];
    if (sid && participants[sid]) {
      io.to(sid).emit('kicked_out');
      delete participants[sid];
      delete sessionIdMap[sessionId];
      io.emit('participants', getParticipantsList());
    }
  });

  // GET PARTICIPANT LIST
  socket.on('get_participants', () => {
    socket.emit('participants', getParticipantsList());
  });

  // HANDLE DISCONNECT
  socket.on('disconnect', () => {
    // Remove from participants and sessionIdMap
    if (participants[socket.id]) {
      const sessionId = participants[socket.id].sessionId;
      delete sessionIdMap[sessionId];
      delete participants[socket.id];
      io.emit('participants', getParticipantsList());
      // Check if all students have voted after removing
      if (currentPoll && allStudentsVoted()) {
        if (pollTimeout) clearTimeout(pollTimeout);
        pollHistory.push({
          question: currentPoll.question,
          options: currentPoll.options,
          votes: currentPoll.votes,
          correctIndex: currentPoll.correctIndex
        });
        currentPoll = null;
        io.emit('poll_ended');
      }
    }
    delete teachers[socket.id];
  });
});

// Helper: Get participant list with name and sessionId
function getParticipantsList() {
  return Object.values(participants).map(p => ({
    name: p.name,
    sessionId: p.sessionId
  }));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`SERVER running on port ${PORT}`);
});
