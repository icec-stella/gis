# Walmart-LINAC Analysis Tool

This is a web-based mapping tool that analyzes the proximity of Walmart stores to LINAC Centers across the United States. It provides an interactive map to visualize the locations and offers analytical tools to determine coverage and gaps.

## Features

-   **Interactive Map**: Displays Walmart and LINAC locations on a map of the United States.
-   **State-based Filtering**: Filter the view by state to see a state-specific map with its boundary.
-   **Adjustable Radius**: Define a proximity radius for analysis.
-   **Proximity Analysis**: Run an analysis to identify which Walmart stores are within the specified radius of LINAC facilities.
-   **Metrics Dashboard**: View statistics for each state, including the number of Walmarts within and outside the coverage radius.
-   **Toggle Markers**: Show or hide Walmart and LINAC location markers on the map.
-   **Data Export**: Download the analysis data in CSV and JSON formats.

## Tech Stack

-   **Frontend**: HTML, CSS, JavaScript, [Bootstrap](https://getbootstrap.com/), [Leaflet.js](https://leafletjs.com/)
-   **Backend**: [Node.js](https://nodejs.org/), [Express.js](https://expressjs.com/)
-   **Data**: Location data is stored in JSON files.

## Setup and Installation

### Prerequisites

-   **Node.js**: You'll need Node.js to run the server. If you don't have it, you can [download it here](https://nodejs.org/en/download/).
-   **A Code Editor**: We recommend using a modern code editor like [Cursor](https://cursor.sh/) or [VS Code](https://code.visualstudio.com/) for a better experience.

### Installation

Before you begin, please ensure you have completed the steps in the **Prerequisites** section above.

1.  **Clone the repository:**

    One way to get the code is by using your code editor to clone the repository. In Cursor or VS Code, open the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`) and type `Git: Clone`. Paste the following URL when prompted:
    
    ```
    https://github.com/icec-stella/gis.git
    ```

    Alternatively, you can use the terminal or command prompt:
    ```bash
    git clone https://github.com/icec-stella/gis.git
    cd gis
    ```

2.  **Install dependencies:**

    Run the following command in the root directory of the project to install the necessary dependencies for both the server and the (future) data processing scripts.

    ```bash
    npm install
    ```

### Running the Application

1.  **Start the server:**

    To start the application, run the following command from the root directory:

    ```bash
    npm start
    ```

    This will start the Node.js server.

2.  **Access the application:**

    Open your web browser, such as Google Chrome or Microsoft Edge, and navigate to:

    ```
    http://localhost:5025
    ```

### Development

If you plan on making changes to the code, we recommend running the server with `nodemon`. This will automatically restart the server whenever a file is saved, so you don't have to do it manually.

```bash
npm run dev
```

## How to Use

1.  **Select a State**: Use the dropdown menu on the left to select a state you want to analyze. The map will zoom to that state and display its boundary.
   
2.  **Set the Radius**: Use the slider to set the desired radius in miles for the analysis.
   
3.  **Run Analysis**: Click the "Run Analysis" button to see the results. Walmarts within the specified radius of a LINAC facility will be highlighted.

4.  **View Metrics**: Click the "Dashboard" button to see a summary of the metrics for the selected state.

5.  **Toggle Views**: Use the "Hide Walmarts" and "Show All Walmarts" buttons to hide the Walmart pins that are not within the specified "Radius". The remaining Walmart pins represent all of the Walmart locations that are not within the specified radius of the nearest LINAC Centers. 

6.  **Download Data**: From the table view, you can download the raw data for your analysis in CSV or JSON format.

## Data Sources

The application uses the following data files located in `src/data/`:

-   `walmart-locations.json`: Contains the locations of Walmart stores.
-   `linac-locations.json`: Contains the locations of LINAC facilities.
