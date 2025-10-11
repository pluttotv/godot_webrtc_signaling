const WebSocket = require('ws');

// Use the PORT environment variable provided by Render, or 8080 for local testing
const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

console.log(`Signaling server started on port ${PORT}...`);

let rooms = new Map();
let clients = new Map(); // Associates a ws instance with a client object { id, roomId }

function generatePassword() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 4; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function broadcastToRoom(roomId, message) {
    const room = rooms.get(roomId);
    if (!room) return;
    
    room.players.forEach(player => {
        if (player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(JSON.stringify(message));
        }
    });
}

wss.on('connection', ws => {
    // Give each connection a unique ID
    ws.id = Date.now() + Math.random().toString(36).substr(2, 9);
    clients.set(ws, { id: ws.id, roomId: null });
    console.log(`Client connected: ${ws.id}`);

    ws.on('message', message => {
        const data = JSON.parse(message);
        const client = clients.get(ws);

        switch (data.type) {
            case 'create_room': {
                const { name, maxPlayers } = data;
                if (name.length < 3 || name.length > 12) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Invalid room name length.' }));
                    return;
                }
                if (rooms.has(name)) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Room name already exists.' }));
                    return;
                }

                const room = {
                    name,
                    password: generatePassword(),
                    maxPlayers: Math.min(Math.max(parseInt(maxPlayers), 2), 4),
                    hostId: ws.id,
                    players: new Map(),
                    sealed: false
                };
                room.players.set(ws.id, { peerId: 1, ready: true, ws });
                rooms.set(name, room);
                client.roomId = name;

                ws.send(JSON.stringify({ type: 'room_created', room }));
                console.log(`Room created: ${name} by ${ws.id}`);
                break;
            }

            case 'join_room': {
                const { name } = data;
                const room = rooms.get(name);
                if (!room || room.sealed) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Room not found or is sealed.' }));
                    return;
                }
                if (room.players.size >= room.maxPlayers) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Room is full.' }));
                    return;
                }

                // Assign the next available peer ID (host is 1)
                const newPeerId = room.players.size + 1;
                room.players.set(ws.id, { peerId: newPeerId, ready: false, ws });
                client.roomId = name;

                ws.send(JSON.stringify({ type: 'join_success', room, myPeerId: newPeerId }));
                broadcastToRoom(name, { type: 'player_list_update', players: Array.from(room.players.values()).map(p => ({ peerId: p.peerId, ready: p.ready })) });
                console.log(`Client ${ws.id} joined room: ${name}`);
                break;
            }
            
            case 'set_ready': {
                const room = rooms.get(client.roomId);
                if (room && room.players.has(ws.id)) {
                    room.players.get(ws.id).ready = data.isReady;
                    broadcastToRoom(client.roomId, { type: 'player_list_update', players: Array.from(room.players.values()).map(p => ({ peerId: p.peerId, ready: p.ready })) });
                }
                break;
            }

            case 'seal_room': {
                const room = rooms.get(client.roomId);
                if (room && room.hostId === ws.id) {
                    const allReady = Array.from(room.players.values()).every(p => p.ready);
                    if (!allReady) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Not all players are ready.' }));
                        return;
                    }
                    room.sealed = true;
                    const playersInfo = Array.from(room.players.values()).map(p => p.peerId);
                    broadcastToRoom(client.roomId, { type: 'start_game', players: playersInfo });
                    console.log(`Room ${client.roomId} sealed and game started.`);
                }
                break;
            }

            // --- WebRTC Signaling ---
            case 'offer':
            case 'answer':
            case 'ice_candidate': {
                const room = rooms.get(client.roomId);
                const targetPlayer = Array.from(room.players.values()).find(p => p.peerId === data.target);
                if (targetPlayer && targetPlayer.ws.readyState === WebSocket.OPEN) {
                    targetPlayer.ws.send(JSON.stringify({
                        type: data.type,
                        from: room.players.get(ws.id).peerId,
                        payload: data.payload
                    }));
                }
                break;
            }
        }
    });

    ws.on('close', () => {
        const client = clients.get(ws);
        if (client && client.roomId) {
            const room = rooms.get(client.roomId);
            if (room) {
                room.players.delete(ws.id);
                // If host leaves, close the room
                if (room.hostId === ws.id) {
                    broadcastToRoom(client.roomId, { type: 'room_closed' });
                    rooms.delete(client.roomId);
                    console.log(`Host left, room ${client.roomId} closed.`);
                } else {
                     broadcastToRoom(client.roomId, { type: 'player_list_update', players: Array.from(room.players.values()).map(p => ({ peerId: p.peerId, ready: p.ready })) });
                }
            }
        }
        clients.delete(ws);
        console.log(`Client disconnected: ${ws.id}`);
    });
});