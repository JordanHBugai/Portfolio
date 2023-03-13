/**
Author(s) : Jordan H. Bugai

ASUrite : jbugai

Course : SER486, Final Project

Instructor : Professor Sandy

Date : December 4th, 2020

Description : File that contains the request FSM and all logic to build and handle
    HTTP requests through the Ethernet controller.
**/

//DEFINES:
#define CRLF "\n\r"
#define GET_REQUEST ((unsigned char)1)
#define PUT_REQUEST_CRIT_HI ((unsigned char)2)
#define PUT_REQUEST_WARN_HI ((unsigned char)3)
#define PUT_REQUEST_CRIT_LO ((unsigned char)4)
#define PUT_REQUEST_WARN_LO ((unsigned char)5)
#define DELTE_LOG_REQUEST ((unsigned char)6)
#define PUT_REQUEST_RESET ((unsigned char)7)
#define PUT_REQUEST_NO_RESET ((unsigned char)8)
#define INVALID ((unsigned char)9)
#define LOW_ALARM ((unsigned char)10)
#define LOW_WARN ((unsigned char)11)
#define NORMAL ((unsigned char)12)
#define HIGH_WARN ((unsigned char)13)
#define HIGH_ALARM ((unsigned char)14)

//INCLUDES:
#include "vpd.h"
#include "log.h"
#include "config.h"
#include "socket.h"
#include "parser.h"
#include "uart.h"
#include "temp.h"
#include "wdt.h"
#include "rtc.h"

//DECLARATIONS:
unsigned char error;

/**
Function Name : requestFSM

Description : FSM for receiving HTTP requests. Entry point is receiving a request in the socket buffer.
    After receiving, the initial string in the buffer is compared to see if it is a GET, PUT, DELETE, or
    invalid request. Upon validation, the system moves to the next phase to validate the type of request received.
    Thereafter, the request is either given an error code of 200 or 400 depending on the validation of the
    request. An appropriate HTTP response is then built and sent to the server.

Arguments :
    (SOCKET) s - A SOCKET macro (unsigned char) representing the socket to connect to.

Returns :
    void

Changes :
    Request FSM - Moves the system into the request FSM when called. Then moves the system through the FSM
        by validating the request line, validating the request itself, and then sending the system into
        the state where it builds the corresponding HTTP response code.
**/
void requestFSM(SOCKET s) {
    processComplete = 0;
    int value;

    //GET REQUEST:
    if (socket_recv_compare(s, "GET")) {
        if (socket_recv_compare(s, " /device")) {
            //Check for appended GET request
            if (socket_recv_compare(s, "/")) {
                requestType = INVALID;
            } else {
                requestType = GET_REQUEST;
            }
        } else {
            requestType = INVALID;
        }

    //PUT REQUESTS:
    } else if (socket_recv_compare(s, "PUT /device")) {
        //Modifying config values
        if (socket_recv_compare(s, "/config?")) {
            //Retrieve config value to modify
            if (socket_recv_compare(s, "tcrit_hi=")) {
                requestType = PUT_REQUEST_CRIT_HI;
            } else if (socket_recv_compare(s, "twarn_hi=")) {
                requestType = PUT_REQUEST_WARN_HI;
            } else if (socket_recv_compare(s, "tcrit_lo=")) {
                requestType = PUT_REQUEST_CRIT_LO;
            } else if (socket_recv_compare(s, "twarn_lo=")) {
                requestType = PUT_REQUEST_WARN_LO;
            } else {
                //Invalid entry
                requestType = INVALID;
            }

            //Store the requested config modification into the 'value' variable.
            if (requestType != INVALID) {
                socket_recv_int(s, &value);
            }

        //If not a modification to the config values, check for reset, no reset, or invalid request.
        } else {
            if (socket_recv_compare(s, "?reset=\"true\"")) {
                requestType = PUT_REQUEST_RESET;
            } else if (socket_recv_compare(s, "?reset=\"false\"")) {
                requestType = PUT_REQUEST_NO_RESET;
            } else {
                requestType = INVALID;
            }
        }

    //DELTE REQUEST:
    } else if (socket_recv_compare(s, "DELETE")) {
        //Check for deletion of the logs or invalid request
        if (socket_recv_compare(s, " /device/log")) {
            requestType = DELTE_LOG_REQUEST;
        } else {
            requestType = INVALID;
        }
    //INVALID REQUEST:
    } else {
        requestType = INVALID;
    }

    //Used to determine the results of the request
    unsigned char result;

    switch (requestType) {
        case GET_REQUEST :
            //Process GET request
            result = 0;
            error = 2;
            buildGetResponse(s);
            break;
        case PUT_REQUEST_CRIT_HI :
            //Process tcrit_hi change
            result = update_tcrit_hi(value);
            if (result == 0) {
                error = 2;
            } else {
                error = 4;
            }
            buildGeneralResponse(s);
            break;
        case PUT_REQUEST_WARN_HI :
            //Process twarn_hi change
            result = update_twarn_hi(value);
            if (result == 0) {
                error = 2;
            } else {
                error = 4;
            }
            buildGeneralResponse(s);
            break;
        case PUT_REQUEST_CRIT_LO :
            //Process tcrit_lo change
            result = update_tcrit_lo(value);
            if (result == 0) {
                error = 2;
            } else {
                error = 4;
            }
            buildGeneralResponse(s);
            break;
        case PUT_REQUEST_WARN_LO :
            //Process twarn_lo change
            result = update_twarn_lo(value);
            if (result == 0) {
                error = 2;
            } else {
                error = 4;
            }
            buildGeneralResponse(s);
            break;
        case PUT_REQUEST_RESET :
            //Force system restart after sending response
            error = 2;
            buildGeneralResponse(s);
            restart = 1;
            break;
        case DELTE_LOG_REQUEST :
            //Delete current log values
            error = 2;
            buildGeneralResponse(s);
            log_clear();
            break;
        case INVALID :
            //Any invalid entry will return an error 400 response
            error = 4;
            buildGeneralResponse(s);
            break;
    }
}

/**
Function Name : buildGetResponse

Description : Used to build a valid GET response. GET response includes a 200 HTTP response code
    and a JSON representation of the VPD, the config values for the temperature system, and all
    log entries.

Arguments :
    (SOCKET) s - A SOCKET macro (unsigned char) representing the socket to connect to.

Returns :
    void

Changes :
    Ethernet - Writes HTTP response information to the Ethernet device.
    Request FSM - Moves the system into the state for writing a 200 response code GET response
        with all of the system information.
**/
void buildGetResponse(SOCKET s) {
    //Write request line
    socket_writestr(s, "HTTP/1.1 ");
    socket_writedec32(s, 200);
    socket_writestr(s, " OK\n\r");

    //Write json content type
    socket_writestr(s, "Content-Type: application/vnd.api+json\n\r");
    socket_writestr(s, CRLF);

    //Write {
    socket_writechar(s, '{');

    //Write "vpd"   //Write :{
    socket_writequotedstring(s, "vpd");
    socket_writestr(s, ":{");

    //Write "model" //Write :   //Write vpd.model in quotes //Write ,
    socket_writequotedstring(s, "model");
    socket_writechar(s, ':');
    socket_writequotedstring(s, vpd.model);
    socket_writechar(s, ',');

    //Write "manufacturer"  //Write :   //Write vpd.manufacturer in quotes  //Write ,
    socket_writequotedstring(s, "manufacturer");
    socket_writechar(s, ':');
    socket_writequotedstring(s, vpd.manufacturer);
    socket_writechar(s, ',');

    //Write "serial_number" //Write :   //Write vpd.serial_number   //Write ,
    socket_writequotedstring(s, "serial_number");
    socket_writechar(s, ':');
    socket_writequotedstring(s, vpd.serial_number);
    socket_writechar(s, ',');

    //Write "manufacturer_date" //Write :   //Write vpd.manufacturer_date in quotes //Write ,
    socket_writequotedstring(s, "manufacture_date");
    socket_writechar(s, ':');
    socket_writedate(s, vpd.manufacture_date);
    socket_writechar(s, ',');

    //Write "mac_address"   //Write mac accdress (socket.h) function
    socket_writequotedstring(s, "mac_address");
    socket_writechar(s, ':');
    socket_write_macaddress(s, vpd.mac_address);
    socket_writechar(s, ',');

    //Write "country_code"  //Write :   //Write vpd.country_code in quotes  //Write },
    socket_writequotedstring(s, "country_code");
    socket_writechar(s, ':');
    socket_writequotedstring(s, vpd.country_of_origin);
    socket_writestr(s, "},");;

    //Write "tcrit_hi" //Write : //Write config.tcrit_hi value //Write ,
    socket_writequotedstring(s, "tcrit_hi");
    socket_writechar(s, ':');
    socket_writedec32(s, config.hi_alarm);
    socket_writechar(s, ',');

    //Write "twarn_hi" //Write : //Write config.twarn_hi value //Write ,
    socket_writequotedstring(s, "twarn_hi");
    socket_writechar(s, ':');
    socket_writedec32(s, config.hi_warn);
    socket_writechar(s, ',');

    //Write "tcrit_lo" //Write : //Write config.tcrit_lo value //Write ,
    socket_writequotedstring(s, "tcrit_lo");
    socket_writechar(s, ':');
    socket_writedec32(s, config.lo_alarm);
    socket_writechar(s, ',');

    //Write "twarn_lo" //Write : //Write config.twarn_lo value //Write ,
    socket_writequotedstring(s, "twarn_lo");
    socket_writechar(s, ':');
    socket_writedec32(s, config.lo_warn);
    socket_writechar(s, ',');

    //Write "temperature" //Write : //Write config.current_temp value //Write ,
    socket_writequotedstring(s, "temperature");
    socket_writechar(s, ':');
    socket_writedec32(s, temp_get());
    socket_writechar(s, ',');

    //Write "state" //Write : //Write tempsfm state //Write ,
    socket_writequotedstring(s, "state");
    socket_writechar(s, ':');
    socket_writequotedstring(s, getTempState(temp_get()));
    socket_writechar(s, ',');

    //Write "log" //Write :[
    //Write all current logs in format {"timestamp":"date_time","event":X},
    socket_writequotedstring(s, "log");
    socket_writestr(s, ":[");
    unsigned char i;
    for (i = 0; i < log_get_num_entries(); i++) {
        unsigned long time = 0;
        unsigned char event = 0;
        if (log_get_record(i, &time, &event)) {
            socket_writechar(s, '{');
            socket_writequotedstring(s, "timestamp");
            socket_writechar(s, ':');

            //Write the log entry timestamp here
            socket_writequotedstring(s, rtc_num2datestr(time));

            socket_writechar(s, ',');
            socket_writequotedstring(s, "event");
            socket_writechar(s, ':');

            //Write the log entry event num
            socket_writedec32(s, event);

            //If there are no more entries, write a '}', otherwise append a ','
            if (i == log_get_num_entries() - 1) {
                socket_writechar(s, '}');
            } else {
                socket_writestr(s, "},");
            }
        }
    }

    //Write ] to close array
    socket_writechar(s, ']');

    //Write }
    socket_writechar(s, '}');
    socket_writestr(s, CRLF);

    //Send response and flag completion
    processComplete = 1;
}

/**
Function Name : buildGeneralResponse

Description : Used to build a general response. Checks to see if the error code is 200 or 400,
    then writes the appropriate HTTP response line and CRLF lines.

Arguments :
    (SOCKET) s - A SOCKET macro (unsigned char) representing the socket to connect to.

Returns :
    void

Changes :
    Ethernet - Writes HTTP response information to the Ethernet device.
    Request FSM - Moves the system into the state for writing a general HTTP response. Response code
        types can be 200 or 400 depending on what the error value was assigned for in the previous
        state.
**/
void buildGeneralResponse(SOCKET s) {
    //Write request line
    socket_writestr(s, "HTTP/1.1 ");
    if (error == 2) {
        socket_writedec32(s, 200);
        socket_writestr(s, " OK\n\r");
    } else {
        socket_writedec32(s, 400);
        socket_writestr(s, " BAD REQUEST\n\r");
    }

    socket_writestr(s, CRLF);

    //Send response and flag completion
    processComplete = 1;
}

/**
Function Name : getTempState

Description : Takes in the current temperature of the system and compares it to the high and low
    warning/alarm values. After comparison, returns the state of the system as a char* string.

Arguments :
    (int) currentTemp - The current temperature of the system.

Returns :
    (char*) - The current state of the system as a string.

Changes :
    N/A
**/
char* getTempState(int currentTemp) {
    char* tempState;
    //Check current temp to set it to corresponding state
    if (currentTemp <= config.lo_alarm) {
        //state = LOW_ALARM;
        tempState = "LOW_CRITICAL";
    } else if (currentTemp <= config.lo_warn && currentTemp > config.lo_alarm) {
        //state = LOW_WARN;
        tempState = "LOW_WARN";
    } else if (currentTemp > config.lo_warn && currentTemp < config.hi_warn) {
        //state = NORMAL;
        tempState = "NORMAL";
    } else if (currentTemp >= config.hi_warn && currentTemp < config.hi_alarm) {
        //state = HIGH_WARN;
        tempState = "HIGH_WARN";
    } else {
        //state = HIGH_ALARM;
        tempState = "HIGH_CRITICAL";
    }

    //Return the temperature state as a string
    return tempState;
}

/**
Function Name : update_tcrit_hi()

Description : Updates the system's hi_alarm value.

Arguments :
    (int) value - The proposed new value for the system's hi_alarm value.

Returns :
    (int) - 0 if new value is okay, otherwise 1.

Changes :
    N/A
**/
unsigned char update_tcrit_hi(int value) {
    if (value > config.hi_warn && value < 0x3FF) {
        config.hi_alarm = value;
        return 0;
    } else {
        return 1;
    }
}

/**
Function Name : update_twarn_hi()

Description : Updates the system's hi_warn value.

Arguments :
    (int) value - The proposed new value for the system's hi_warn value.

Returns :
    (int) - 0 if new value is okay, otherwise 1

Changes :
    N/A
**/
unsigned char update_twarn_hi(int value) {
    if (value > config.lo_warn && value < config.hi_alarm) {
        config.hi_warn = value;
        return 0;
    } else {
        return 1;
    }
}

/**
Function Name : update_twarn_lo()

Description : Updates the system's lo_warn value.

Arguments :
    (int) value - The proposed new value for the system's lo_warn value.

Returns :
    (int) - 0 if new value is okay, otherwise 1

Changes :
    N/A
**/
unsigned char update_twarn_lo(int value) {
    if (value > config.lo_alarm && value < config.hi_warn) {
        config.lo_warn = value;
        return 0;
    } else {
        return 1;
    }
}

/**
Function Name : update_tcrit_lo()

Description : Updates the system's lo_alarm value.

Arguments :
    (int) value - The proposed new value for the system's lo_alarm value.

Returns :
    (int) - 0 if new value is okay, otherwise 1

Changes :
    N/A
**/
unsigned char update_tcrit_lo(int value) {
    if (value < config.lo_warn) {
        config.lo_alarm = value;
        return 0;
    } else {
        return 1;
    }
}
