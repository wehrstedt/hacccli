# hacccli - Home Assistant Custom Components Command Line Interface
A Command Line Interface for managing home assistant custom components.

## Why should you use hacccli?
With hacccli, you can easily add and automatically update custom components for your home assistant instance.

Wait. Isn't there already a community store with which I can manage custom components via the web frontend? Yes! If you are already using the [Home Assistant Community Store](https://hacs.xyz/), then this tool is probably pretty useless for you.

For all other people, which does not have the [Home Assistant Community Store](https://hacs.xyz/) installed (and maybe dont want to), this cli tool will help you managing your custom components.

## Adding a custom component
To add a custom component, you can simply call the cli tool and paste the GitHub URL of the custom component. hacccli will download the custom component after asking you a few questions and keeps track of new versions (if you like to):

![add-component.gif](/dist/add-component.gif)

**What happened?**   
hacccli has downloaded the custom component [alexa_meda_player](https://github.com/custom-components/alexa_media_player) to the directory `config/custom_components/alexa_media_player`. Additionaly, hacccli stores all added components inside a json-db to keep track on new versions of the added components (see [Update components](#update-components)).

### Track updates
To track updates of a custom component, hacccli ask you if you want to track version updates by releases or by branches.   

`releases`   
If you choose releases, hacccli uses semantic versioning to track new versions. You can select which versions hacccli should automatically update without asking you:
* **major** No restriction
* **minor** Only minor version updates (1.1.2 -> 1.x.x, but not 2.x.x or greater)
* **patch** Only patch version updates (1.1.2 -> 1.1.x but not 1.2.x or greater)

`branches`   
If you choose branches, hacccli ask you which branch it should track. It will also remember the commit hash of the installed version and updates the component on every new commit on that branch.

## Update components
hacccli can also automatically update all custom components which were installed with hacccli. You can either update components manually, by selecting the command `fetch registered components`, or by calling hacccli with the argument `--fetch` to let hacccli fetch new version in a non-interactive mode.

### Manually update custom components
To update all added components, just select the command `fetch registered components`:

![update-component.gif](/dist/update-component.gif)

Thats all!

If hacccli finds a version which does not meet your selected semver-constraint, e. g. you have installed version 1.2.3 and version 2.0.0 is avaiable but you choosed `minor` when you added the component, hacccli will not update to version 2.0.0. If you start hacccli in an interactive mode, it ask you if you like to upgrade to a newer version. In a non interactive mode hacccli will just skip the custom component.

![update-component-conflict-interactive.gif](/dist/update-component-conflict-interactive.gif)

### Automatically update custom components
For automating custom component updates you can start hacccli in a non-interactive mode by executing the following command:
```sh
hacccli --fetch
```

hacccli will the update all added components with regarding your selected semantic versioning constraint. If you selected a branch instead of releases, then hacccli will redownload the hole component on every new commit.

![update-component-non-interactive.gif](/dist/update-component-non-interactive.gif)

Setup e. g. a cron job to run hacccli in the non-interactive mode every day.
