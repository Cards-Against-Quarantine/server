const mysql = require("mysql");
const helpers = require("./helpers");

var db = mysql.createConnection({
  host: process.env.MYSQL_HOST || "localhost",
  user: process.env.MYSQL_USER || "cah-online",
  password: process.env.MYSQL_PASS || "password",
  database: process.env.MYSQL_DB || "cah-online"
});

db.connect((err) => {
  if (err) throw err;
  console.log("Connected to the MySQL Database!");
});

// Pass through the query method
exports.query = (sql, params, fn) => {
  db.query(sql, params, fn);
};

/*********
 * Users *
 *********/

exports.setUserIcon = (userId, icon) => {
  db.query(`UPDATE users SET icon = ? WHERE id = ?;`, [
    icon,
    userId
  ],(err, result) => {
    if (err) return console.warn("Failed to set icon for user #" + userId + ":", err);
    console.debug("Set icon for user #" + userId + " to '" + icon + "'");
  });
};

exports.setUserName = (userId, name) => {
  db.query(`UPDATE users SET name = ? WHERE id = ?;`, [
    name,
    userId
  ],(err, result) => {
    if (err) return console.warn("Failed to set name for user #" + userId + ":", err);
    console.debug("Set name for user #" + userId + " to '" + name + "'");
  });
};

/*********
 * Rooms *
 *********/

exports.getRoom = (roomId, fn) => {
  if (!roomId) return fn({error: "Room ID is required"});
  var sql = `
    SELECT token, edition, rotate_czar as rotateCzar
    FROM rooms
    WHERE id = ?;
  `;
  db.query(sql, [
    roomId
  ],(err, results, fields) => {
    if (err) {
      console.warn("Failed to get room #" + roomId + ":", err);
      return fn({error: "MySQL Error"});
    } else if (results.length == 0) {
      return fn({error: "Invalid Room ID"});
    }
    fn({
      id: roomId,
      token: results[0].token,
      edition: results[0].edition,
      rotateCzar: results[0].rotateCzar
    });
  });
};

exports.getRoomWithToken = (roomId, token, fn) => {
  if (!helpers.validateHash(token, 8)) return fn({error: "Token is required"});
  exports.getRoom(roomId, room => {
    if (room.error) return fn(room);
    if (room.token != token) return fn({error: "Invalid Token"});
    return fn(room);
  });
};

exports.addUserToRoom = (userId, roomId) => {
  db.query(`INSERT INTO room_users (user_id, room_id) VALUES (?, ?);`, [
    userId,
    roomId
  ], (err, result) => {
    if (err) return console.warn("Failed to add user #" + userId + " to room #" + roomId + ":", err);
    console.debug("Added user #" + userId + " to room #" + roomId);
  });
};

exports.getRoomUsers = (roomId, fn) => {
  var sql = `
    SELECT id, name, icon
    FROM users 
    WHERE id IN (
      SELECT user_id
      FROM room_users
      WHERE room_id = ?
    );
  `;
  db.query(sql, [
    roomId
  ],(err, results, fields) => {
    if (err) {
      console.warn("Failed to get users for room #" + roomId + ":", err);
      return fn({error: "MySQL Error"});
    }

    var roomUsers = {};
    var roomUserIds = [];

    // Convert arrays to objects (TODO: efficiency?)
    results.forEach(row => {
      roomUserIds.push(row.id);
      roomUsers[row.id] = {
        id: row.id,
        name: row.name,
        icon: row.icon
      };
    });
    fn({users: roomUsers, userIds: roomUserIds});
  });
};

exports.deleteRoom = (roomId) => {
  db.query(`DELETE FROM rooms WHERE id = ?;`, [
    roomId
  ], (err, result) => {
    if (err) return console.warn("Failed to delete room #" + roomId + ":", err);
    console.log("Deleted room #" + roomId);
  });
};

/********
 * Chat *
 ********/

exports.getLatestMessages = (roomId, limit, fn) => {
  var sql = `
    SELECT 
      msg.id, 
      msg.user_id AS userId, 
      msg.content, 
      msg.system_msg AS isSystemMsg, 
      GROUP_CONCAT(likes.user_id SEPARATOR ',') AS likes
    FROM messages msg
    LEFT JOIN message_likes likes ON msg.id = likes.message_id
    WHERE room_id = ?
    GROUP BY msg.id
    ORDER BY msg.id DESC
    LIMIT ?;`;
  db.query(sql, [
    roomId,
    limit
  ],(err, results, fields) => {
    if (err) {
      console.warn("Failed to get messages for room #" + roomId + ":", err);
      return fn({error: "MySQL Error"});
    }
    var roomMessages = {};

    results.forEach(row => {
      roomMessages[row.id] = {
        id: row.id,
        userId: row.userId,
        content: row.content,
        isSystemMsg: row.isSystemMsg,
        likes: row.likes ? row.likes.split(",") : []
      }
    });
    fn({messages: roomMessages});
  });  
};

exports.createMessage = (userId, content, isSystemMsg, fn) => {
  if (!helpers.validateString(content)) return fn({error: "Invalid Message"});
  content = helpers.stripHTML(content);

  // We get the room ID from room_users in order to create the message
  db.query(`
    INSERT INTO messages (room_id, user_id, content, system_msg) 
    VALUES ((SELECT room_id FROM room_users WHERE user_id = ?), ?, ?, ?);
  `, [
    userId,
    userId,
    content,
    isSystemMsg
  ], (err, result) => {
    if (err) {
      console.warn("Failed to create message:", err);
      return fn({error: "MySQL Error"});
    }
    var msgId = result.insertId;

    // Create an object to represent the message on the client
    fn({
      id: msgId,
      userId: userId,
      content: content,
      isSystemMsg: isSystemMsg,
      likes: []
    });
  });
};

/*********
 * Cards *
 *********/

function getCards(roomId, black, count, fn) {
  if (!helpers.validateUInt(roomId)) return fn({error: "Invalid Room ID"});
  if (!helpers.validateUInt(count)) count = 1;
  var color = black ? "black" : "white";
  var sql = `
    SELECT *
    FROM ${color}_cards
    WHERE id IN (
      SELECT card_id 
      FROM ${color}_cards_link 
      WHERE edition IN (
        SELECT edition
        FROM rooms
        WHERE id = ${roomId}
      )
    ) AND id NOT IN (
      SELECT card_id
      FROM room_${color}_cards
      WHERE room_id = ${roomId}
    )
    ORDER BY RAND()
    LIMIT ${count};
  `;
  db.query(sql, (err, results, fields) => {
    if (err) {
      console.warn(`Failed to get ${color} card:`, err);
      return fn({error: "MySQL Error"});
    } else if (results.length == 0) return fn({error: "No cards left!"});

    var cards = [];
    var cardsSql = [];

    results.forEach(result => {
      cardsSql.push(`(${result.id}, ${roomId})`);
      var card = {id: result.id, text: result.text};
      if (black) {
        card.draw = result.draw;
        card.pick = result.pick;
      }
      cards.push(card);
    });

    fn(cards);

    // Prevent the chosen cards from being reused
    var sql = `INSERT INTO room_${color}_cards (card_id, room_id) VALUES `;
    db.query(sql + cardsSql.join(", ") + ";", (err, results) => {
      if (err) return console.warn(`Failed to add cards to room_${color}_cards:`, err);
    });
  });
}

exports.getBlackCard = (roomId, fn) => {
  getCards(roomId, true, 1, cards => {
    if (cards.error) return fn(cards);
    fn(cards[0]);
  });
};

exports.getWhiteCards = (roomId, count, fn) => {
  getCards(roomId, false, count, cards => {
    if (cards.error) return fn(cards);
    fn(cards);
  });
}