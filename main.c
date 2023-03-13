/**
Author(s) : Jordan H. Bugai, Douglas Sandy

ASUrite : jbugai

Course : SER486, Final Project

Instructor : Professor Sandy

Date : December 4th, 2020

Description : Main entry point of program; initializes all the hardware to be used,
    establishes connection over the ethernet device, and handles HTTP requests/responses through a
    Request FSM.
**/

//INCLUDES:
#include "config.h"
#include "delay.h"
#include "dhcp.h"
#include "led.h"
#include "log.h"
#include "rtc.h"
#include "spi.h"
#include "uart.h"
#include "vpd.h"
#include "temp.h"
#include "socket.h"
#include "alarm.h"
#include "wdt.h"
#include "tempfsm.h"
#include "eeprom.h"
#include "ntp.h"
#include "w51.h"
#include "signature.h"
#include "parser.h"

//DEFINES:
#define HTTP_PORT       8080	/* TCP port for HTTP */
#define SERVER_SOCKET   0

//DECLARATIONS:
int current_temperature = 75;

/**
Function Name : main()

Description : Main function called upon entry to program. Initializes all hardware to be used, initializes connections through the Ethernet,
    then handles all incoming HTTP requests by calling the Request FSM. All logic is handled through the cyclic executive loop and stays
    running until the program is closed.

Arguments :
    void

Returns :
    (int) - 0 upon exit.

Changes :
    UART - Initializes the hardware, then uses it to write text to the UART console regarding the connection state
        and the state of opening and closing connections.
    LED - Initializes the hardware, then sets the LED blink pattern/timing according to when the LED is updated
        on each iteration through the cyclic executive. See the temp.h and tempfsm.h files for more information.
    VPD - Initialize the VPD struct in the EEPROM hardware.
    Config - Initialize the config struct in the EEPROM hardware, then update its state every iteration through the cyclic executive
        loop. Config struct values control the temperature limits in the system that flag other hardware used.
    Log - Initialize the read of logs written to the EEPROM regarding events within the system.
    RTC - Initialize the RTC for date-time representations and the associated timer.
    SPI - Initializes the SPI library.
    Temp - Initializes the temperature measurement hardware and uses the corresponding functions to read
        and update the temp values.
    W51 - Initializes and configures the W51 ethernet controller.
    Temp FSM - Initializes the temp FSM, then updates the FSM on changing temperature limits and updates in the system.
    Request FSM - Enters the request FSM when there is information in the receive buffer to be processed. Moves the system
        into the next state in the FSM in which it will begin to parse and analyze the HTTP request.
**/
int main(void) {
	/* Initialize the hardware devices
	 * uart, led, vpd, config, log, rtc, spi,
     * temp sensor, W51 Ethernet controller, temp FSM
     */
     uart_init();
     led_init();
     vpd_init();
     config_init();
     log_init();
     rtc_init();
     spi_init();
     temp_init();
     W5x_init();
     tempfsm_init();

    /* sign the assignment
    * Asurite is the first part of your asu email (before the @asu.edu
    */
    signature_set("Jordan","Bugai","jbugai");

    /* configure the W51xx ethernet controller prior to DHCP */
    unsigned char blank_addr[] = {0,0,0,0};
    W5x_config(vpd.mac_address, blank_addr, blank_addr, blank_addr);

    /* loop until a dhcp address has been gotten */
    while (!dhcp_start(vpd.mac_address, 60000UL, 4000UL)) {}
    uart_writestr("local ip: ");uart_writeip(dhcp_getLocalIp());

    /* configure the MAC, TCP, subnet and gateway addresses for the Ethernet controller*/
    W5x_config(vpd.mac_address, dhcp_getLocalIp(), dhcp_getGatewayIp(), dhcp_getSubnetMask());

	/* add a log record for EVENT_TIMESET prior to synchronizing with network time */
	log_add_record(EVENT_TIMESET);

    /* synchronize with network time */
    ntp_sync_network_time(5);

    /* add a log record for EVENT_NEWTIME now that time has been synchronized */
    log_add_record(EVENT_NEWTIME);

    /* start the watchdog timer */
    wdt_init();

    /* log the EVENT STARTUP and send and ALARM to the Master Controller */
    log_add_record(EVENT_STARTUP);
    alarm_send(EVENT_STARTUP);

    /* request start of test if 'T' key pressed - You may run up to 3 tests per
     * day.  Results will be e-mailed to you at the address asurite@asu.edu
     */
    check_for_test_start();

    /* start the first temperature reading and wait 5 seconds before reading again
    * this long delay ensures that the temperature spike during startup does not
    * trigger any false alarms.
    */
    temp_start();
    delay_set(1,5000);

    while (1) {
        /* reset  the watchdog timer every loop */
        wdt_reset();

        /* update the LED blink state */
        led_update();

        /* if the temperature sensor delay is done, update the current temperature
        * from the temperature sensor, update the temperature sensor finite state
        * machine (which provides hysteresis) and send any temperature sensor
        * alarms (from FSM update).
        */
        if (delay_isdone(1)) {
            /* read the temperature sensor */
            current_temperature = temp_get();

            /* update the temperature fsm and send any alarms associated with it */
            tempfsm_update(current_temperature,config.hi_alarm,config.hi_warn,config.lo_alarm,config.lo_warn);

            /* restart the temperature sensor delay to trigger in 1 second */
            temp_start();
            delay_set(1,1000);
        }

        //Check to see if the server socket is closed
        if (socket_is_closed(SERVER_SOCKET)) {
            uart_writestr("\n\rOpening socket\n\r");
             //Open socket and place it in listen mode
            socket_open(SERVER_SOCKET, HTTP_PORT);
            socket_listen(SERVER_SOCKET);
        }

        //Check to see if there is anything in the receive buffer
        if (socket_recv_available(SERVER_SOCKET) > 0) {

            //Check to see if the processing has finished
            if (processComplete) {
                uart_writestr("Closing socket\n\r");
                //Flush rest of the data
                while (socket_recv_available(SERVER_SOCKET)) {
                    socket_flush_line(SERVER_SOCKET);
                }
                uart_writestr("Socket flushed\n\r");
                //Set processComplete back to 0 and disconnect the socket
                processComplete = 0;
                socket_disconnect(SERVER_SOCKET);

                //Check if restart was triggered. If so, set restart flag back to 0,
                //  then set config to modified and update before requesting WDT restart
                if (restart == 1) {
                    restart = 0;
                    config_set_modified();
                    config_update();
                    wdt_force_restart();
                }

            } else {
            //Handle the request by calling the Request FSM
            uart_writestr("Handling request\n\r");
            requestFSM(SERVER_SOCKET);
            delay_set(1, 2000);
            }
        }

        /* update any pending log write backs */
        log_update();

        /* update any pending config write backs */
        config_update();
    }
	return 0;
}
