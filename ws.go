package main

import (
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

var Upgrader = websocket.Upgrader{
	HandshakeTimeout: 5 * time.Second,
	ReadBufferSize:   1024,
	WriteBufferSize:  1024,
	CheckOrigin: func(r *http.Request) bool {
		return true // for now
	},
}

func handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := Upgrader.Upgrade(w, r, nil)
	if err != nil {
		w.WriteHeader(500)
		log.Printf("Error in Upgrading to Websocket: %v", err)
		return
	}
	fmt.Printf("Connected: %+v\n", conn)
}
