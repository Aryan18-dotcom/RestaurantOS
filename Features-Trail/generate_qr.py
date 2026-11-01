import os
from dotenv import load_dotenv
import qrcode
from PIL import Image

# 1. Load environment variables from .env file
load_dotenv()

UPI_ID = os.getenv("UPI_ID")
PAYEE_NAME = os.getenv("PAYEE_NAME")
CURRENCY = os.getenv("CURRENCY", "INR")

def main():
    # Verify environment variables exist

    if not UPI_ID or not PAYEE_NAME:
        print("Error: Please set UPI_ID and PAYEE_NAME in your .env file.")
        return

    # 1. Prompt terminal for the amount
    amount = input("Enter the payment amount (₹): ").strip()
    if not amount:
        print("Amount cannot be empty.")
        return

    # 2. Add bank details and terminal amount into a single payment string
    # Using URL encoding for the payee name to handle spaces safely
    import urllib.parse
    encoded_name = urllib.parse.quote(PAYEE_NAME)
    
    payment_string = f"upi://pay?pa={UPI_ID}&pn={encoded_name}&am={amount}&cu={CURRENCY}"

    # 5. In terminal print the string
    print("\n" + "="*50)
    print(" PAYMENT URI STRING:")
    print("="*50)
    print(payment_string)
    print("="*50 + "\n")

    # 3. Generate the QR from that string
    # ERROR_CORRECT_H (High) is essential so the QR remains scannable even with a logo covering its center
    qr = qrcode.QRCode(
        version=4,
        error_correction=qrcode.constants.ERROR_CORRECT_H,
        box_size=10,
        border=4,
    )
    qr.add_data(payment_string)
    qr.make(fit=True)

    # Create base QR image
    img = qr.make_image(fill_color="black", back_color="white").convert('RGB')

    # 4. Add the logo from /public/log.png to the center of the QR
    logo_path = os.path.join("public", "log.png")
    if os.path.exists(logo_path):
        try:
            logo = Image.open(logo_path)
            
            # Calculate logo size (roughly 20-25% of the QR code dimensions)
            qr_width, qr_height = img.size
            logo_size = qr_width // 4
            logo = logo.resize((logo_size, logo_size), Image.Resampling.LANCZOS)
            
            # Calculate center position
            pos = ((qr_width - logo_size) // 2, (qr_height - logo_size) // 2)
            
            # Paste logo onto the QR code image
            img.paste(logo, pos)
            print(f" Logo successfully embedded from {logo_path}")
        except Exception as e:
            print(f" Warning: Could not process logo image. Error: {e}")
    else:
        print(f" Warning: Logo not found at '{logo_path}'. Generating clean QR without logo.")

    # Save final image to disk
    output_image_path = "payment_qr_final.png"
    img.save(output_image_path)
    print(f" QR Image saved successfully as '{output_image_path}'\n")

    # 5. Print ASCII QR code in terminal
    print("="*50)
    print(" TERMINAL QR CODE PREVIEW:")
    print("="*50)
    qr.print_ascii(invert=True)
    print("="*50)

if __name__ == "__main__":
    main()