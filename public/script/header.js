window.onload = ()=>{

    if(document.getElementById("searchButton")){
        var searchButton = document.getElementById("searchButton");
        var formSearch = document.getElementById("formSearch");

        searchButton.addEventListener("click",()=>{
        searchButton.style.display = "none";
        formSearch.style.display = "";
        document.getElementById("searchInput").focus();
        })
    }



}