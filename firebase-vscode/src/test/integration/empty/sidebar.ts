import { browser } from "@wdio/globals";
import { FirebaseSidebar } from "../../utils/page_objects/sidebar";

it("Supports opening empty projects", async function () {
  const workbench = await browser.getWorkbench();
  // Wait for the workbench to load
  workbench.wait(50000);

  const sidebar = new FirebaseSidebar(workbench);

  await sidebar.open();

  await sidebar.runInFirebaseViewContext(async (firebase) => {
    await firebase.runFirebaseInitElement.waitForDisplayed();
  });
});
