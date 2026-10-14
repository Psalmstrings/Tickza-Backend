let ioInstance = null;

export const initSocket = (io) => {
  ioInstance = io;

  io.on('connection', (socket) => {
    socket.on('join_user', (userId) => {
      if (userId) {
        socket.join(`user_${userId}`);
      }
    });

    socket.on('join_event', (eventId) => {
      if (eventId) {
        socket.join(`event_${eventId}`);
      }
    });

    socket.on('disconnect', () => {});
  });
};

export const emitToUser = (userId, eventName, payload) => {
  if (ioInstance && userId) {
    ioInstance.to(`user_${userId}`).emit(eventName, payload);
  }
};

export const emitToEvent = (eventId, eventName, payload) => {
  if (ioInstance && eventId) {
    ioInstance.to(`event_${eventId}`).emit(eventName, payload);
  }
};

export const emitBroadcast = (eventName, payload) => {
  if (ioInstance) {
    ioInstance.emit(eventName, payload);
  }
};
