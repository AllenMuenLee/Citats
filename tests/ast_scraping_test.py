import nodriver as uc
import asyncio
import time

async def main():
    browser = await uc.start()
    page = await browser.get('https://www.airbnb.com/s/Seattle--WA/homes?place_id=ChIJVTPokywQkFQRmtVEaUZlJRA&refinement_paths%5B%5D=%2Fhomes&checkin=2026-08-29&checkout=2026-08-31&date_picker_type=calendar&adults=1&guests=1&search_type=HOMEPAGE_CAROUSEL_CLICK')
    
    # Extract the raw accessibility tree via CDP
    time.sleep(5)
    ax_tree = await page.send(uc.cdp.accessibility.get_full_ax_tree())
    
    open("ax_tree.json", "w").write(str(ax_tree))
    browser.stop()

if __name__ == '__main__':
    uc.loop().run_until_complete(main())