package main

import (
	"fmt"
	"log"
	"net/http"
)

func main() {
	fmt.Println("Started Canvas")

	http.Handle("/", http.FileServer(http.Dir("static")))
	http.HandleFunc("/ws", handleWS)

	log.Fatal(http.ListenAndServe(":8080", nil))
}
