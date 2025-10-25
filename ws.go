package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

// User represents connected user
type User struct {
	UserID   string
	UserName string
	DocID    string
	Conn     *websocket.Conn
	Send     chan []byte
}

type Message struct {
	Type      string     `json:"type"`
	Content   string     `json:"content,omitempty"`
	Title     string     `json:"title,omitempty"`
	UserID    string     `json:"userId,omitempty"`
	UserName  string     `json:"username,omitempty"`
	Position  int        `json:"position,omitempty"`
	Cursor    int        `json:"cursor,omitempty"`
	Users     []UserMeta `json:"users,omitempty"`
	Timestamp int64      `json:"timestamp,omitempty"`
	Message   string     `json:"message,omitempty"`
}

type UserMeta struct {
	UserID   string `json:"userId"`
	UserName string `json:"username"`
}

type Document struct {
	DocID   string
	Title   string
	Content string
}

var (
	Upgrader = websocket.Upgrader{
		HandshakeTimeout: 5 * time.Second,
		ReadBufferSize:   1024,
		WriteBufferSize:  1024,
		CheckOrigin: func(r *http.Request) bool {
			return true // for now
		},
	}

	clients   = make(map[string]*User)
	docUsers  = make(map[string]map[string]*User)
	documents = make(map[string]*Document)

	mu sync.Mutex
)

func handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := Upgrader.Upgrade(w, r, nil)
	if err != nil {
		w.WriteHeader(500)
		log.Printf("Error in Upgrading to Websocket: %v", err)
		return
	}
	fmt.Println("Connection Upgraded to Websockets successfully")

	q := r.URL.Query()
	docID := q.Get("doc")
	if docID == "" {
		docID = uuid.NewString()
	}

	initialName := q.Get("user")
	userID := uuid.NewString()

	user := &User{
		UserID:   userID,
		UserName: initialName,
		DocID:    docID,
		Conn:     conn,
		Send:     make(chan []byte, 1024),
	}

	mu.Lock()
	clients[userID] = user
	if _, ok := docUsers[docID]; !ok {
		docUsers[docID] = make(map[string]*User)
	}
	docUsers[docID][userID] = user

	if _, ok := documents[docID]; !ok {
		documents[docID] = &Document{
			DocID:   docID,
			Title:   "Untitled Document",
			Content: "",
		}
	}
	doc := documents[docID]

	usersList := make([]UserMeta, 0, len(docUsers[docID]))
	for uid, u := range docUsers[docID] {
		usersList = append(usersList, UserMeta{UserID: uid, UserName: u.UserName})
	}
	mu.Unlock()

	// Send initial content
	initMsg := Message{
		Type:      "init",
		Content:   doc.Content,
		Title:     doc.Title,
		UserID:    userID,
		Timestamp: time.Now().UnixMilli(),
		Users:     usersList,
	}
	data, _ := json.Marshal(initMsg)
	conn.WriteMessage(websocket.TextMessage, data)

	joined := Message{
		Type:      "user_joined",
		UserID:    userID,
		UserName:  user.UserName,
		Timestamp: time.Now().UnixMilli(),
	}
	broadcastToDoc(docID, joined, userID)
	sendUsersListToDoc(docID)

	go writePump(user)
	readPump(user)
}

// writePump takes message from broadcast and
// writes to client's connection i.e. it sends message to the client
// this connects to onmessage()->handleMessage() in our js script
func writePump(u *User) {
	for msg := range u.Send {
		if err := u.Conn.WriteMessage(websocket.TextMessage, msg); err != nil {
			log.Printf("Write error: %v", err)
			break
		}
	}
}

// readPump reads the message from client and then broadcasts it
// i.e. it receives message from client
// this connects to our sendMesage() in js script
func readPump(u *User) {
	defer func() {
		mu.Lock()
		delete(clients, u.UserID)
		if userMap, ok := docUsers[u.DocID]; ok {
			delete(userMap, u.UserID)
			if len(userMap) == 0 {
				delete(docUsers, u.DocID)
			}
		}
		mu.Unlock()

		left := Message{
			Type:      "user_left",
			UserID:    u.UserID,
			UserName:  u.UserName,
			Timestamp: time.Now().UnixMilli(),
		}
		broadcastToDoc(u.DocID, left, u.UserID)
		sendUsersListToDoc(u.DocID)

		u.Conn.Close()
		close(u.Send)
	}()

	for {
		_, raw, err := u.Conn.ReadMessage()
		if err != nil {
			log.Printf("read error: %v", err)
			break
		}

		var msg Message
		if err := json.Unmarshal(raw, &msg); err != nil {
			continue
		}

		msg.UserID = u.UserID
		if msg.UserName != "" {
			u.UserName = msg.UserName
		}
		msg.UserName = u.UserName
		msg.Timestamp = time.Now().Unix()

		switch msg.Type {
		case "username_change":
			u.UserName = msg.UserName
			sendUsersListToDoc(u.DocID)
			joined := Message{
				Type:      "user_joined",
				UserID:    u.UserID,
				UserName:  u.UserName,
				Timestamp: time.Now().UnixMilli(),
			}
			broadcastToDoc(u.DocID, joined, u.UserID)
		case "text_change":
			if content := msg.Content; content != "" || content == "" {
				mu.Lock()
				if d, ok := documents[u.DocID]; ok {
					d.Content = msg.Content
				}
				mu.Unlock()
			}
			broadcastRawToDoc(u.DocID, raw, u.UserID)
		case "cursor_position":
			broadcastRawToDoc(u.DocID, raw, u.UserID)
		case "save":
			if msg.Content != "" {
				mu.Lock()
				if d, ok := documents[u.DocID]; ok {
					d.Content = msg.Content
				}
				mu.Unlock()
			}
			resp := Message{
				Type:      "save_success",
				Timestamp: time.Now().UnixMilli(),
			}
			sendToUser(u, resp)
		case "rename":
			if msg.Title != "" {
				mu.Lock()
				if d, ok := documents[u.DocID]; ok {
					d.Title = msg.Title
				}
				mu.Unlock()
				// broadcast rename to other clients (and optionally to sender)
				renameMsg := Message{
					Type:      "rename",
					Title:     msg.Title,
					Timestamp: time.Now().UnixMilli(),
				}
				broadcastToDoc(u.DocID, renameMsg, "")
			}
		default:
			// unknown message: ignore or optionally respond with error
			errMsg := Message{
				Type:      "error",
				Message:   "unknown message type",
				Timestamp: time.Now().UnixMilli(),
			}
			sendToUser(u, errMsg)
		}
	}
}

func sendToUser(u *User, m Message) {
	buf, err := json.Marshal(m)
	if err != nil {
		return
	}
	select {
	case u.Send <- buf:
	default:
		log.Printf("dropping message to %s", u.UserName)
	}
}

func broadcastToDoc(docID string, m Message, senderID string) {
	buf, err := json.Marshal(m)
	if err != nil {
		return
	}
	broadcastRawToDoc(docID, buf, senderID)
}

func broadcastRawToDoc(docId string, msg []byte, senderID string) {
	mu.Lock()
	defer mu.Unlock()
	usersMap, ok := docUsers[docId]
	if !ok {
		return
	}
	for uid, u := range usersMap {
		if senderID != "" && uid == senderID {
			continue
		}
		select {
		case u.Send <- msg:
		default:
			close(u.Send)
			delete(clients, uid)
			delete(usersMap, uid)
		}
	}
}

func sendUsersListToDoc(docID string) {
	mu.Lock()
	usersMap, ok := docUsers[docID]
	if !ok {
		mu.Unlock()
		return
	}
	users := make([]UserMeta, 0, len(usersMap))
	for uid, u := range usersMap {
		users = append(users, UserMeta{UserID: uid, UserName: u.UserName})
	}
	mu.Unlock()

	msg := Message{
		Type:      "users_list",
		Users:     users,
		Timestamp: time.Now().UnixMilli(),
	}
	broadcastToDoc(docID, msg, "")
}
