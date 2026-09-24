Feature: GitLab CE Issue work inside VS Code
  The selected group keeps an assigned-to-me tree while creation and detail work in a Webview.

  @automated @SCN-001
  Scenario: A complete CE creation form opens a newly created unassigned issue
    Given the Issue Webview is ready for creation
    When the selected group supplies a project and its form options
    Then the CE creation controls and similar issue search are available
    When I create an unassigned confidential issue with Markdown
    Then a typed create request contains the CE fields and no token
    When GitLab returns the newly created issue detail
    Then the unassigned issue is open in the detail view

  @automated @SCN-002
  Scenario: Creation sends the chosen template, metadata, and dates
    Given the Issue Webview is ready for creation
    When the selected group supplies a project and its form options
    And I fill the template and every project metadata field
    Then the create request contains the selected CE values

  @automated @SCN-003
  Scenario: A failed project change leaves the creation form bound to its original project
    Given the Issue Webview is ready for creation
    When the selected group supplies two projects
    And I choose another project but GitLab rejects its form options
    Then the form remains on the first project and can only create there

  @automated @SCN-004
  Scenario: A project without create permission cannot submit an issue
    Given the Issue Webview is ready for creation
    When GitLab reports no create permission for the selected project
    Then the create action is disabled

  @automated @SCN-005
  Scenario: Initial load failures can be retried
    Given the Issue Webview is ready for creation
    When GitLab cannot load the selected group
    Then the loading error is visible with a retry action

  @automated @SCN-006
  Scenario: Markdown, activity, and attachment use typed messages and sanitized HTML
    Given the Issue Webview is ready with an editable issue
    When GitLab renders Markdown containing an unsafe script
    Then the rendered description contains safe Markdown without script
    And a private upload image is requested through the host
    When I request an attachment
    Then the Webview sends a typed upload request without a token

  @automated @SCN-007
  Scenario: Markdown rendering failure still shows the description source
    Given the Issue Webview is ready with an editable issue
    When GitLab cannot render the description Markdown
    Then the original Markdown text remains readable

  @automated @SCN-008
  Scenario: A comment can preview Markdown and attach a file
    Given the Issue Webview is ready with an editable issue
    When I preview and attach a file to a comment
    Then the comment preview and attachment remain in the comment editor

  @automated @SCN-009
  Scenario: An internal comment cannot accidentally start a public thread
    Given the Issue Webview is ready with an editable issue
    When I mark a comment as internal
    Then starting a public thread is disabled

  @automated @SCN-010
  Scenario: Late Markdown replies cannot replace a newly opened issue
    Given the Issue Webview is ready with an editable issue
    When I open another issue before the old Markdown reply arrives
    Then only the new issue Markdown remains visible

  @automated @SCN-011
  Scenario: A stale edit remains recoverable after GitLab rejects the save
    Given the Issue Webview is ready with an editable issue
    When I change the title and save
    Then the update request includes the last seen revision
    When GitLab reports a save conflict
    Then the changed title and conflict message remain visible
    When I reload the latest issue after the conflict
    Then my draft remains and a retry uses the latest revision

  @automated @SCN-012
  Scenario: Discussion and notification controls send the intended actions
    Given the Issue Webview is ready with an editable issue
    When I comment, reply, subscribe, and add a to-do
    Then the corresponding typed actions are sent without a token

  @automated @SCN-013
  Scenario: Linked issues, child tasks, time, move, clone, and delete have controls
    Given the Issue Webview is ready with an editable issue
    Then the relationship, child task, time, move, clone, and delete controls are available
    When I request a clone with comments
    Then the typed clone request includes comments and the target project

  @automated @SCN-014
  Scenario: Moving or cloning can find a project outside the selected group
    Given the Issue Webview is ready with an editable issue
    When I search for a target project in another group
    Then the other group project can be selected for moving or cloning

  @automated @SCN-015
  Scenario: The time report supports dated logging and individual deletion
    Given the Issue Webview is ready with an editable issue
    When GitLab supplies a time report and I log time on a chosen date
    Then the dated time action and a permitted timelog deletion are available

  @automated @SCN-016
  Scenario: A child task can be inspected and edited inside the Issue card
    Given the Issue Webview is ready with an editable issue
    When I inspect and edit a child task
    Then the task update stays inside the Issue Webview

  @automated @SCN-017
  Scenario: A comment has its own reactions
    Given the Issue Webview is ready with an editable issue
    When I use a reaction on a comment
    Then the comment reaction sends its own typed operation

  @automated @SCN-018
  Scenario: Restricted access and failed API calls retain a usable detail view
    Given the Issue Webview is ready with a read-only issue
    Then editing and destructive controls are hidden
    When GitLab rejects an action
    Then the error is visible and the issue remains open

  @automated @SCN-022
  Scenario: A rejected comment edit preserves its draft until a successful retry
    Given the Issue Webview is ready with an editable issue
    When I edit my comment and GitLab rejects the save
    Then my changed comment and the error remain in the editor
    When GitLab accepts the retried comment edit
    Then the editor closes and the updated comment is shown

  @automated @SCN-023
  Scenario: A notification action does not discard unsaved issue edits
    Given the Issue Webview is ready with an editable issue
    When I edit issue fields and subscribing refreshes the detail
    Then my unsaved issue fields stay in the editor
    When I successfully save those issue fields
    Then the editor closes with the saved issue fields

  @automated @SCN-024
  Scenario: Posting one thread reply keeps other reply drafts
    Given the Issue Webview is ready with an editable issue
    When I draft replies in two threads and post the first
    Then only the posted thread reply draft is cleared

  @automated @SCN-025
  Scenario: A changed comment falls back to its new Markdown when rendering fails
    Given the Issue Webview is ready with an editable issue
    When a previously rendered comment changes and its new preview fails
    Then the changed comment source remains visible without stale HTML

  @automated @SCN-026
  Scenario: Canceling a destructive confirmation leaves the detail usable
    Given the Issue Webview is ready with an editable issue
    When I request deletion and cancel the confirmation
    Then the detail stays open and actions are available again

  @automated @SCN-027
  Scenario: Text entered after submitting a comment or child task remains a draft
    Given the Issue Webview is ready with an editable issue
    When I enter another comment and child title while their requests are pending
    Then the later comment and child title remain after GitLab responds

  @automated @SCN-028
  Scenario: A field changed while an issue save is pending remains editable
    Given the Issue Webview is ready with an editable issue
    When I change a field again before the prior save completes
    Then the later field value remains ready for another save

  @human @SCN-019
  Scenario: An unassigned CE issue is created and opened inside VS Code
    Given VS Code is connected to the local CE instance with a test token
    When I choose a project in the selected group and create a test issue with Markdown, a file, an assignee, labels, milestone, dates, and confidentiality
    Then the new issue opens in the VS Code detail view even if it is not assigned to me
    And My Issues still lists only issues assigned to me in the selected group

  @human @SCN-020
  Scenario: CE issue details and discussion work inside VS Code
    Given I open a disposable test issue from My Issues
    When I edit its fields, close and reopen it, preview Markdown, comment, reply, react, subscribe, and add a to-do
    Then the detail view and the matching GitLab Issue show the same fields, activity, and notification state

  @human @SCN-021
  Scenario: CE relationship, time, and lifecycle controls work inside VS Code
    Given I open disposable test issues with permission to manage them
    When I link an issue, create and edit a child task, log and delete time, clone with comments, move, and delete a test issue
    Then each result appears in the VS Code detail view and the matching GitLab Issue
