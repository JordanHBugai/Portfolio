/**
Author(s) : Jordan H. Bugai

ASUrite : jbugai

Course : SER486, Final Project

Instructor : Professor Sandy

Date : December 4th, 2020

Description : Header file for parser.c; contains all variables and functions to be used
    in files that include this header.
**/

//DECLARATIONS:
unsigned char requestType;
unsigned char processComplete;
unsigned char restart;

void requestFSM(SOCKET s);  //FSM to receive and handle HTTP requests

void buildGetResponse(SOCKET s);    //Entered from the request FSM, used to build a GET response

void buildGeneralResponse(SOCKET s);    //Entered from the request FSM, used to build a response for other requests

char* getTempState(int currentTemp);    //Set the system's current temperature state and return it as a string.

unsigned char update_tcrit_hi(int value);   //Update the config.tcrit_hi value

unsigned char update_twarn_hi(int value);   //Update the config.twarn_hi value

unsigned char update_twarn_lo(int value);   //Update the config.twarn_lo value

unsigned char update_tcrit_lo(int value);   //Update the config.tcrit_lo value
