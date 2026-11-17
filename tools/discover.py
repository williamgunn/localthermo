#!/usr/bin/env python3
"""Print the BlueDOT's GATT services so you can copy the service UUID into the app.

    pip install bleak
    python3 tools/discover.py                    # find a device named BlueDOT
    python3 tools/discover.py 00:A0:50:42:A1:D8  # or connect by address (not on macOS)

Close the ThermoWorks phone app first: the BlueDOT accepts one connection at a time.
"""
import asyncio
import sys

from bleak import BleakClient, BleakScanner

UPDATES_UUID = "783f2991-23e0-4bdc-ac16-78601bd84b39"


async def main(address):
    if address:
        device = await BleakScanner.find_device_by_address(address, timeout=20)
    else:
        device = await BleakScanner.find_device_by_filter(
            lambda d, adv: (d.name or adv.local_name or "").startswith("BlueDOT"), timeout=20
        )
    if device is None:
        sys.exit("No BlueDOT found. Is it switched on, in range, and not connected to a phone?")

    print(f"Found {device.name} at {device.address}\n")
    service_uuid = None
    async with BleakClient(device) as client:
        for service in client.services:
            print(f"service {service.uuid}")
            for char in service.characteristics:
                marker = "   <-- temperature updates" if char.uuid.lower() == UPDATES_UUID else ""
                print(f"    characteristic {char.uuid} [{', '.join(char.properties)}]{marker}")
                if marker:
                    service_uuid = service.uuid
        if service_uuid:
            frame = await client.read_gatt_char(UPDATES_UUID)
            print(f"\nraw frame: {frame.hex(' ')}")

    if service_uuid:
        print(f"\nPaste this into the app's Bluetooth setup:\n\n    {service_uuid}\n")
    else:
        print("\nThe expected temperature characteristic was not found. Please share the list above.")


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else None))
